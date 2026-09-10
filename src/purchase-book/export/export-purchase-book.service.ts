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

/** Todo lo que no puede viajar en el nombre del archivo ni en un header HTTP. */
const NON_FILENAME_SAFE_NIT = /[^A-Za-z0-9]/g;

export interface AnexoExportResult {
  rows: AnexoCell[][];
  /**
   * NIT del receptor del archivo. Todas las filas comparten receptor por
   * construcción (`receptorId` es obligatorio y `collectRows` lo verifica), así
   * que este dato identifica al contribuyente que declara y nombra el archivo.
   */
  receptorNit: string;
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

    // El DTO ya declara `receptorId` como obligatorio, pero esta guarda no
    // sobra: esa validación falló una vez en silencio, porque un `@IsOptional()`
    // heredado de la clase base cortocircuitaba el validador de la subclase y el
    // `ValidationPipe` dejaba pasar el export sin receptor. La consecuencia no es
    // un error visible sino un archivo fiscalmente inválido, que mezcla en la
    // declaración de una empresa las compras de otra. El servicio no confía en la
    // capa de validación para una condición de validez fiscal.
    if (!dto.receptorId) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_BOOK_RECEPTOR_REQUIRED',
        message:
          'El Anexo 3 se presenta por contribuyente: hay que elegir un receptor antes de exportar.',
      });
    }

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

    // Defensa en profundidad sobre `buildPurchaseDocumentWhere`, que ya filtra
    // por `receptorId`. Se repite acá porque la falla es silenciosa y fiscal: un
    // archivo con dos receptores no se rompe, se ve normal y declara las compras
    // de otra empresa dentro de la declaración propia. Si alguna vez el armado
    // del `where` deja de aplicar el filtro, esto lo convierte en un 422 visible
    // en vez de un anexo mal presentado.
    //
    // Va DESPUÉS de las guardas de filtro vacío y de tope de filas: así nunca
    // recorre un conjunto sin acotar y el usuario recibe primero el error que
    // realmente describe su filtro.
    const receptorGroups = await this.prisma.withTenant(tenantId, (tx) =>
      tx.purchaseDocument.groupBy({ by: ['receptorId'], where }),
    );

    if (receptorGroups.length > 1) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_BOOK_MULTIPLE_RECEPTORS',
        message: `El filtro incluye compras de ${receptorGroups.length} receptores. El Anexo 3 se presenta por contribuyente: el export tiene que abarcar un solo receptor.`,
      });
    }

    // Guarda de identidad partida (Addendum 11, fase 2, punto 5). Mientras la
    // fusión del histórico no ocurra, un mismo contribuyente puede existir como
    // dos partes —unos proveedores lo identifican con el NIT de 14 dígitos y
    // otros con el homologado al DUI, de 9— y exportar una de ellas deja las
    // compras de la otra fuera de la declaración, sin error y sin aviso. Es
    // exactamente el problema que originó el addendum: no se puede resolver acá,
    // pero sí se puede impedir que se presente una declaración incompleta sin
    // que nadie lo sepa.
    await this.assertNoSplitIdentity(tenantId, dto.receptorId, where);

    const rows = await this.buildRows(tenantId, where, total);

    if (rows.anomalies.supplierId > 0 || rows.anomalies.totalMismatch > 0) {
      this.logger.warn(
        { tenantId, ...rows.anomalies, total },
        'El Anexo 3 exportado tiene filas con anomalías que conviene revisar',
      );
    }

    return rows;
  }

  /**
   * Falla si el receptor elegido tiene **partes hermanas** —misma clave canónica,
   * distinta fila— con compras que este mismo filtro habría incluido de haber
   * estado bajo el receptor elegido.
   *
   * El conteo se hace con el `where` del export y `receptorId` reemplazado por
   * las hermanas, no con un "¿tiene documentos en algún lado?": una parte hermana
   * sin compras en el período no afecta esta declaración, y avisar de ella
   * sería ruido — y un aviso que suena cuando no pasa nada enseña a ignorarlo.
   *
   * Va DESPUÉS de las guardas de filtro vacío y de tope de filas, por la misma
   * razón que la de receptor único: primero el error que describe el filtro.
   */
  private async assertNoSplitIdentity(
    tenantId: string,
    receptorId: string,
    where: Prisma.PurchaseDocumentWhereInput,
  ): Promise<void> {
    const receptor = await this.prisma.withTenant(tenantId, (tx) =>
      tx.dteParty.findFirst({
        where: { id: receptorId, tenantId },
        select: { canonicalKey: true },
      }),
    );

    // Sin clave canónica no hay con qué emparentar: la cascada NRC > NIT-14 >
    // DUI-9 no cubrió a esta parte. No se inventa una identidad para bloquear un
    // export; el gate de la fase 1 verificó que hoy en producción no hay ninguna
    // en esa situación.
    const canonicalKey = receptor?.canonicalKey;
    if (!canonicalKey) return;

    const siblings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.dteParty.findMany({
        where: { tenantId, canonicalKey, id: { not: receptorId } },
        select: { id: true, nit: true },
      }),
    );

    if (siblings.length === 0) return;

    const excluded = await this.prisma.withTenant(tenantId, (tx) =>
      tx.purchaseDocument.count({
        where: { ...where, receptorId: { in: siblings.map((sibling) => sibling.id) } },
      }),
    );

    if (excluded === 0) return;

    const identifiers = siblings
      .map((sibling) => sibling.nit)
      .sort()
      .join(', ');

    this.logger.warn(
      { tenantId, receptorId, canonicalKey, siblings: siblings.length, excluded },
      'Export del Anexo 3 bloqueado: el receptor tiene partes sin fusionar con compras en el filtro',
    );

    throw new UnprocessableEntityException({
      error: 'PURCHASE_BOOK_SPLIT_RECEPTOR',
      message:
        `El receptor elegido comparte identidad (clave canónica ${canonicalKey}) con ` +
        `${siblings.length === 1 ? 'otra parte' : `otras ${siblings.length} partes`} sin fusionar ` +
        `(${identifiers}). Quedarían ${excluded} compras fuera de esta declaración. ` +
        'Hay que fusionar las partes antes de exportar.',
    });
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

    // Todos los documentos del filtro comparten receptor, así que alcanza con
    // leerlo de las filas que ya se recorren: no se agrega otra consulta.
    let receptorNit = '';

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
        if (!receptorNit) receptorNit = doc.receptorNit;
        const row = buildAnexoRow(doc, doc.receptor);
        rows.push(row.cells);
        accumulate(anomalies, row.flags);
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }

    return { rows, receptorNit, anomalies };
  }

  /**
   * Nombre del archivo, saneado y con componentes ASCII.
   *
   * El NIT del receptor va en el nombre porque un mismo operador exporta el
   * anexo de varios contribuyentes: sin él, dos archivos del mismo período son
   * indistinguibles en la carpeta de descargas y es fácil presentar el del
   * cliente equivocado.
   *
   * El NIT se acota a `[A-Za-z0-9]` antes de entrar al nombre. No es cosmético:
   * el valor viene del JSON del DTE, o sea de quien envía el correo, y el parser
   * solo exige que no esté vacío (`getRequiredString`). `sanitizeFilename` quita
   * separadores y caracteres de control, pero deja pasar cualquier punto de
   * código sobre U+00FF, y `res.setHeader` lanza `ERR_INVALID_CHAR` con esos
   * valores en `Content-Disposition`. Como el NIT queda persistido, un solo DTE
   * con un carácter así dejaría el export de ese receptor devolviendo 500 de
   * forma permanente. Un NIT legítimo es alfanumérico, así que acotarlo no
   * pierde información real.
   */
  buildFileName(dto: ExportPurchaseBookDto, extension: string, receptorNit: string): string {
    const period = dto.month ?? dto.from ?? new Date().toISOString().slice(0, 10);
    // El fallback cubre un NIT ilegible y el caso en que no se leyó ninguna
    // fila: el nombre nunca queda con un segmento vacío. La validez fiscal del
    // archivo no depende del nombre, así que degrada en vez de fallar.
    const nit = receptorNit.replace(NON_FILENAME_SAFE_NIT, '') || 'sin-nit';
    return sanitizeFilename(`compras_${nit}_${period}.${extension}`);
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
