import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { sanitizeFilename } from '../../common/utils/sanitize-filename';
import { AnexoCell, AnexoRowFlags, buildAnexoRow } from '../anexo/build-anexo-row';
import { buildPurchaseDocumentWhere, buildUnclassifiedWhere } from '../purchase-book.service';
import { DOCUMENT_EXPORT_SELECT } from '../purchase-book.projections';
import { ExportPurchaseBookDto } from '../dto/export-purchase-book.dto';

/** Tamaño de lote del recorrido por cursor. */
const BATCH_SIZE = 500;

export interface AnexoExportResult {
  rows: AnexoCell[][];
  /** Anomalías acumuladas, para loguear y avisar al contador. */
  anomalies: {
    supplierId: number;
    negativeAmount: number;
    totalMismatch: number;
    incompleteClassification: number;
  };
}

/**
 * Recolección de filas del Anexo 3 (Addendum 10, §8.1).
 *
 * El recorrido es por cursor en lotes de 500 y NUNCA hace `findMany` sin
 * `take`: un tenant con años de compras no puede tumbar el proceso con una
 * sola consulta.
 */
@Injectable()
export class ExportPurchaseBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ExportPurchaseBookService.name);
  }

  /**
   * Valida los topes ANTES de emitir cualquier byte y devuelve las filas ya
   * armadas. Una vez que la respuesta empieza a fluir ya no se puede mandar un
   * error limpio, así que todo lo que pueda fallar se verifica acá.
   */
  async collectRows(ctx: TenantContext, dto: ExportPurchaseBookDto): Promise<AnexoExportResult> {
    const tenantId = this.requireTenantId(ctx);
    const where = buildPurchaseDocumentWhere(tenantId, dto);

    const [total, unclassified] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.purchaseDocument.count({ where }),
        tx.purchaseDocument.count({ where: buildUnclassifiedWhere(where) }),
      ]),
    );

    if (total === 0) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_BOOK_EMPTY',
        message: 'El filtro seleccionado no incluye ninguna compra para exportar',
      });
    }

    const maxRows = this.config.purchaseBookExportMaxRows;
    if (total > maxRows) {
      throw new UnprocessableEntityException({
        error: 'EXPORT_TOO_LARGE',
        message: `El filtro incluye ${total} compras, más del límite de ${maxRows}. Acotá el período antes de exportar.`,
      });
    }

    if (unclassified > 0 && !dto.allowUnclassified) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_BOOK_UNCLASSIFIED',
        message: `Hay ${unclassified} compras sin clasificar en las columnas Q a T. Clasificalas o exportá con allowUnclassified=true.`,
      });
    }

    const rows = await this.buildRows(tenantId, where, total);

    if (rows.anomalies.supplierId > 0 || rows.anomalies.totalMismatch > 0) {
      this.logger.warn(
        { tenantId, ...rows.anomalies, total },
        'El Anexo 3 exportado tiene filas con anomalías que conviene revisar',
      );
    }

    return rows;
  }

  private async buildRows(
    tenantId: string,
    where: Prisma.PurchaseDocumentWhereInput,
    total: number,
  ): Promise<AnexoExportResult> {
    const rows: AnexoCell[][] = [];
    const anomalies = {
      supplierId: 0,
      negativeAmount: 0,
      totalMismatch: 0,
      incompleteClassification: 0,
    };

    let cursor: string | undefined;

    // El orden es ascendente por fecha de emisión: es como el contador espera
    // leer el anexo y como lo revisa contra sus comprobantes.
    while (rows.length < total) {
      const batch = await this.prisma.withTenant(tenantId, (tx) =>
        tx.purchaseDocument.findMany({
          where,
          select: DOCUMENT_EXPORT_SELECT,
          orderBy: [{ fecEmi: 'asc' }, { id: 'asc' }],
          take: BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );

      if (batch.length === 0) break;

      for (const doc of batch) {
        const row = buildAnexoRow(doc, doc.receptor);
        rows.push(row.cells);
        accumulate(anomalies, row.flags);
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }

    return { rows, anomalies };
  }

  /** Nombre del archivo, saneado y con componentes ASCII. */
  buildFileName(dto: ExportPurchaseBookDto, extension: string): string {
    const period = dto.month ?? dto.from ?? new Date().toISOString().slice(0, 10);
    return sanitizeFilename(`compras_${period}.${extension}`);
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no exporta el libro de compras de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}

function accumulate(anomalies: AnexoExportResult['anomalies'], flags: AnexoRowFlags): void {
  if (flags.supplierIdAnomaly) anomalies.supplierId += 1;
  if (flags.negativeAmount) anomalies.negativeAmount += 1;
  if (flags.totalMismatch) anomalies.totalMismatch += 1;
  if (flags.incompleteClassification) anomalies.incompleteClassification += 1;
}
