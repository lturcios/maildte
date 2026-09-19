import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { rangeEnd, rangeStart } from '../common/utils/date-range';
import { DteEnqueuer } from './queue/dte-enqueuer';
import { PARSER_VERSION } from './parser/dte-parser';
import { ANEXO_CLASSIFICATION_EPOCH } from './anexo/resolve-classification';
import { ListPurchaseDocumentsDto } from './dto/list-purchase-documents.dto';
import { PurchaseDocumentFiltersDto } from './dto/purchase-document-filters.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';
import { UpdateDocumentActivityDto } from './dto/update-document-activity.dto';
import {
  ActivityWhere,
  attachResolvedActivity,
  buildActivityFilter,
  WithResolvedActivity,
} from './activity/activity-resolution';
import { assertActivityAssignableToReceptor } from './activity/activity-guards';
import { ReprocessDto } from './dto/reprocess.dto';
import { ListParseResultsDto } from './dto/list-parse-results.dto';
import {
  DOCUMENT_DETAIL_SELECT,
  DOCUMENT_LIST_SELECT,
  PARSE_RESULT_SELECT,
  PurchaseDocumentDetailRow,
  PurchaseDocumentListRow,
} from './purchase-book.projections';

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

export interface PurchaseBookSummary {
  documentCount: number;
  totalExenta: string;
  totalNoSuj: string;
  totalGravada: string;
  ivaCreditoFiscal: string;
  montoTotalOperacion: string;
  /** Documentos con período ≥ 2024-02 y alguna columna Q–T sin resolver. */
  unclassifiedCount: number;
  /** Adjuntos JSON del tenant que todavía no pasaron por el parser. */
  jsonAttachmentsWithoutParse: number;
}

export interface ReprocessResult {
  enqueued: number;
  nextCursor: string | null;
}

const ZERO = '0';

/**
 * Construye el `where` del listado. Exportada y pura para poder testearla sin
 * Prisma, igual que `buildExportWhere` del módulo de export.
 *
 * `tenantId` es siempre el primer filtro aunque RLS ya aísle: defensa en
 * profundidad, y además permite que el planner use los índices compuestos
 * `[tenantId, fecEmi]`, `[tenantId, receptorId, fecEmi]`, etc.
 *
 * Recibe la base `PurchaseDocumentFiltersDto` para servir tanto al listado como
 * al export, que declaran `receptorId` por separado.
 */
export function buildPurchaseDocumentWhere(
  tenantId: string,
  dto: PurchaseDocumentFiltersDto,
  activityWhere?: ActivityWhere,
): Prisma.PurchaseDocumentWhereInput {
  const where: Prisma.PurchaseDocumentWhereInput = { tenantId };
  const and: Prisma.PurchaseDocumentWhereInput[] = [];

  if (dto.emisorId) where.emisorId = dto.emisorId;
  if (dto.receptorId) where.receptorId = dto.receptorId;
  if (dto.accountId) where.accountId = dto.accountId;

  // `month` gana sobre `from`/`to`: es el atajo de período fiscal del panel y
  // no tendría sentido intersecarlo con un rango escrito a mano.
  const range = dto.month ? monthRange(dto.month) : explicitRange(dto.from, dto.to);
  if (range) where.fecEmi = range;

  if (dto.q) {
    const contains = dto.q.trim();
    if (contains.length > 0) {
      where.OR = [
        { numeroControl: { contains, mode: 'insensitive' } },
        { codigoGeneracion: { contains, mode: 'insensitive' } },
        { emisorNombre: { contains, mode: 'insensitive' } },
      ];
    }
  }

  const classification = classificationFilter(dto.classification);
  if (classification) {
    // AND explícito para no pisar el OR de la búsqueda libre.
    and.push(...classification);
  }

  // El filtro por actividad trae su propio OR (override del documento o default
  // del proveedor) y va dentro del AND por la misma razón: un OR suelto en la
  // raíz se fusionaría con el de la búsqueda libre y ensancharía el resultado
  // en vez de acotarlo. `activityWhere` ya viene resuelto contra la base —
  // `buildActivityFilter()`—, para que esta función siga siendo pura.
  if (activityWhere) and.push(activityWhere);

  if (and.length > 0) where.AND = and;

  return where;
}

function monthRange(month: string): Prisma.DateTimeFilter {
  const [year, monthPart] = month.split('-').map(Number);
  // Día 0 del mes siguiente = último día de este mes, sin tabla de días por mes.
  const lastDay = new Date(Date.UTC(year, monthPart, 0)).getUTCDate();
  return {
    gte: rangeStart(`${month}-01`),
    lte: rangeStart(`${month}-${String(lastDay).padStart(2, '0')}`),
  };
}

/**
 * `fecEmi` es DATE: el driver la entrega como medianoche UTC, así que el
 * extremo superior se ancla al inicio del día, no al final. Usar `rangeEnd`
 * acá funcionaría igual, pero anclar al inicio deja explícito que se compara
 * contra un DATE y no contra un instante.
 */
function explicitRange(from?: string, to?: string): Prisma.DateTimeFilter | null {
  if (!from && !to) return null;
  const filter: Prisma.DateTimeFilter = {};
  if (from) filter.gte = rangeStart(from);
  if (to) filter.lte = rangeStart(to);
  return filter;
}

/** Un documento está sin clasificar si alguna de las 4 columnas queda sin resolver. */
function unclassifiedConditions(): Prisma.PurchaseDocumentWhereInput[] {
  return [
    { anexoTipoOperacion: null, receptor: { defaultTipoOperacion: null } },
    { anexoClasificacion: null, receptor: { defaultClasificacion: null } },
    { anexoSector: null, receptor: { defaultSector: null } },
    { anexoTipoCostoGasto: null, receptor: { defaultTipoCostoGasto: null } },
  ];
}

function classificationFilter(
  value: PurchaseDocumentFiltersDto['classification'],
): Prisma.PurchaseDocumentWhereInput[] | null {
  if (!value || value === 'all') return null;

  // Antes de febrero 2024 las columnas Q–T van en "0" por instructivo: esos
  // documentos no cuentan como pendientes de clasificar.
  const inScope = { fecEmi: { gte: ANEXO_CLASSIFICATION_EPOCH } };

  if (value === 'unclassified') {
    return [inScope, { OR: unclassifiedConditions() }];
  }
  return [
    {
      OR: [
        { fecEmi: { lt: ANEXO_CLASSIFICATION_EPOCH } },
        { NOT: { OR: unclassifiedConditions() } },
      ],
    },
  ];
}

/** Condición de "sin clasificar" con el filtro base ya aplicado, para el resumen. */
export function buildUnclassifiedWhere(
  base: Prisma.PurchaseDocumentWhereInput,
): Prisma.PurchaseDocumentWhereInput {
  return {
    ...base,
    AND: [
      ...(Array.isArray(base.AND) ? base.AND : base.AND ? [base.AND] : []),
      { fecEmi: { gte: ANEXO_CLASSIFICATION_EPOCH } },
      { OR: unclassifiedConditions() },
    ],
  };
}

/**
 * Selección de adjuntos JSON a re-encolar según el modo del backfill.
 *
 * Exportada y pura a propósito: la comparten el endpoint
 * `POST /purchase-book/reprocess` (un tenant, con token ADMIN) y el script de
 * mantenimiento `scripts/backfill-purchase-book.ts` (todos los tenants, desde
 * el host del VPS). Si cada uno armara su propio `where`, un cambio de modo se
 * aplicaría en una vía y no en la otra.
 */
export function buildReprocessWhere(
  tenantId: string,
  dto: ReprocessDto,
): Prisma.AttachmentWhereInput {
  const where: Prisma.AttachmentWhereInput = { tenantId, fileType: 'JSON' };

  const email: Prisma.ProcessedEmailWhereInput = {};
  if (dto.accountId) email.accountId = dto.accountId;
  if (dto.month) email.monthFolder = dto.month;
  if (dto.from || dto.to) {
    email.receivedAt = {
      ...(dto.from ? { gte: rangeStart(dto.from) } : {}),
      ...(dto.to ? { lte: rangeEnd(dto.to) } : {}),
    };
  }
  if (Object.keys(email).length > 0) where.email = email;

  if (dto.mode === 'missing') {
    where.parseResult = { is: null };
  } else if (dto.mode === 'failed') {
    // Sin ledger, con un estado de error, o parseado por una versión anterior
    // del parser (que es el caso al subir PARSER_VERSION).
    where.OR = [
      { parseResult: { is: null } },
      {
        parseResult: {
          status: {
            in: ['ERROR', 'JSON_INVALIDO', 'ARCHIVO_FALTANTE', 'ARCHIVO_DEMASIADO_GRANDE'],
          },
        },
      },
      { parseResult: { parserVersion: { lt: PARSER_VERSION } } },
    ];
  }
  // `all` no agrega condición: re-parsea todo el filtro con force.

  return where;
}

@Injectable()
export class PurchaseBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly enqueuer: DteEnqueuer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PurchaseBookService.name);
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async findAll(
    ctx: TenantContext,
    dto: ListPurchaseDocumentsDto,
  ): Promise<Paginated<WithResolvedActivity<PurchaseDocumentListRow>>> {
    const tenantId = this.requireTenantId(ctx);

    const [data, total] = await this.prisma.withTenant(tenantId, async (tx) => {
      const where = buildPurchaseDocumentWhere(
        tenantId,
        dto,
        await this.resolveActivityFilter(tx, tenantId, dto),
      );

      const [rows, count] = await Promise.all([
        tx.purchaseDocument.findMany({
          where,
          select: DOCUMENT_LIST_SELECT,
          orderBy: [{ fecEmi: 'desc' }, { createdAt: 'desc' }],
          skip: (dto.page - 1) * dto.limit,
          take: dto.limit,
        }),
        tx.purchaseDocument.count({ where }),
      ]);

      // La actividad efectiva se resuelve sobre la página ya recortada, no
      // sobre el filtro: son dos consultas acotadas por `limit`, no una por
      // fila.
      return [await attachResolvedActivity(tx, tenantId, rows), count] as const;
    });

    return { data, meta: { page: dto.page, limit: dto.limit, total } };
  }

  /**
   * Traduce el `activityId` del filtro a un predicado, o `undefined` si no hay
   * filtro por actividad. Corre dentro de la transacción de quien llama porque
   * consulta el catálogo y el mapeo.
   */
  private async resolveActivityFilter(
    tx: Prisma.TransactionClient,
    tenantId: string,
    dto: PurchaseDocumentFiltersDto,
  ): Promise<ActivityWhere | undefined> {
    if (!dto.activityId) return undefined;
    const { where } = await buildActivityFilter(tx, tenantId, dto.activityId, dto.receptorId);
    return where;
  }

  async summary(ctx: TenantContext, dto: ListPurchaseDocumentsDto): Promise<PurchaseBookSummary> {
    const tenantId = this.requireTenantId(ctx);

    const [aggregate, unclassifiedCount, jsonAttachmentsWithoutParse] =
      await this.prisma.withTenant(tenantId, async (tx) => {
        // El resumen tiene que sumar EXACTAMENTE lo que el listado muestra: si
        // el filtro por actividad no llegara hasta acá, los totales de una
        // pantalla filtrada serían los del contribuyente completo.
        const where = buildPurchaseDocumentWhere(
          tenantId,
          dto,
          await this.resolveActivityFilter(tx, tenantId, dto),
        );
        return Promise.all([
          tx.purchaseDocument.aggregate({
            where,
            _count: { _all: true },
            _sum: {
              totalExenta: true,
              totalNoSuj: true,
              totalGravada: true,
              ivaCreditoFiscal: true,
              montoTotalOperacion: true,
            },
          }),
          tx.purchaseDocument.count({ where: buildUnclassifiedWhere(where) }),
          // Señal para el panel: si hay JSON sin parsear, el libro está
          // incompleto y conviene ofrecer el botón de reprocesar.
          tx.attachment.count({
            where: { tenantId, fileType: 'JSON', parseResult: { is: null } },
          }),
        ]);
      });

    const sums = aggregate._sum;
    return {
      documentCount: aggregate._count._all,
      totalExenta: sums.totalExenta?.toString() ?? ZERO,
      totalNoSuj: sums.totalNoSuj?.toString() ?? ZERO,
      totalGravada: sums.totalGravada?.toString() ?? ZERO,
      ivaCreditoFiscal: sums.ivaCreditoFiscal?.toString() ?? ZERO,
      montoTotalOperacion: sums.montoTotalOperacion?.toString() ?? ZERO,
      unclassifiedCount,
      jsonAttachmentsWithoutParse,
    };
  }

  /** Detalle. `rawJson` solo se incluye para ADMIN (Addendum 10, §10.8). */
  async findOne(
    ctx: TenantContext,
    id: string,
  ): Promise<
    WithResolvedActivity<PurchaseDocumentDetailRow> & { rawJson: Prisma.JsonValue | null }
  > {
    const tenantId = this.requireTenantId(ctx);
    const includeRaw = ctx.actor.role === Role.ADMIN;

    const document = await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.purchaseDocument.findFirst({
        where: { id, tenantId },
        select: { ...DOCUMENT_DETAIL_SELECT, rawJson: includeRaw },
      });
      if (!row) return null;
      // La misma resolución que el listado, sobre una fila: el detalle tiene
      // que decir de dónde salió la actividad —override o default del
      // proveedor—, que es justo lo que el contador necesita ver antes de
      // corregirla.
      const [resolved] = await attachResolvedActivity(tx, tenantId, [row]);
      return resolved;
    });

    if (!document) {
      throw new NotFoundException({
        error: 'PURCHASE_DOCUMENT_NOT_FOUND',
        message: 'Documento de compra no encontrado',
      });
    }

    return {
      ...document,
      rawJson: includeRaw ? (document as { rawJson: Prisma.JsonValue }).rawJson : null,
    };
  }

  async listParseResults(ctx: TenantContext, dto: ListParseResultsDto) {
    const tenantId = this.requireTenantId(ctx);
    const where: Prisma.DteParseResultWhereInput = { tenantId };
    if (dto.status) where.status = dto.status;
    if (dto.attachmentId) where.attachmentId = dto.attachmentId;

    const [data, total] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.dteParseResult.findMany({
          where,
          select: PARSE_RESULT_SELECT,
          orderBy: { parsedAt: 'desc' },
          skip: (dto.page - 1) * dto.limit,
          take: dto.limit,
        }),
        tx.dteParseResult.count({ where }),
      ]),
    );

    return { data, meta: { page: dto.page, limit: dto.limit, total } };
  }

  // -------------------------------------------------------------------------
  // Clasificación
  // -------------------------------------------------------------------------

  async updateClassification(
    ctx: TenantContext,
    id: string,
    dto: UpdateClassificationDto,
  ): Promise<PurchaseDocumentDetailRow & { rawJson: Prisma.JsonValue | null }> {
    const tenantId = this.requireTenantId(ctx);

    // Solo se escriben las claves presentes en el body: un PATCH parcial no
    // debe borrar los overrides que el usuario no mencionó.
    const data: Prisma.PurchaseDocumentUpdateInput = {
      classifiedById: ctx.actor.id,
      classifiedAt: new Date(),
    };
    if ('anexoTipoOperacion' in dto) data.anexoTipoOperacion = dto.anexoTipoOperacion ?? null;
    if ('anexoClasificacion' in dto) data.anexoClasificacion = dto.anexoClasificacion ?? null;
    if ('anexoSector' in dto) data.anexoSector = dto.anexoSector ?? null;
    if ('anexoTipoCostoGasto' in dto) data.anexoTipoCostoGasto = dto.anexoTipoCostoGasto ?? null;
    if ('anexoNota' in dto) data.anexoNota = dto.anexoNota ?? null;

    await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.purchaseDocument.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          error: 'PURCHASE_DOCUMENT_NOT_FOUND',
          message: 'Documento de compra no encontrado',
        });
      }
      await tx.purchaseDocument.update({ where: { id }, data });
    });

    this.logger.info(
      { tenantId, documentId: id, actorId: ctx.actor.id },
      'Clasificación del Anexo 3 actualizada',
    );
    return this.findOne(ctx, id);
  }

  // -------------------------------------------------------------------------
  // Actividad económica del documento (Addendum 11, fase 3)
  // -------------------------------------------------------------------------

  /**
   * Override de la actividad de una compra: la punta de la cascada
   * `override del documento > default del proveedor > sin clasificar`.
   *
   * `activityId: null` quita el override y devuelve el documento al default de
   * su proveedor. No deja el documento sin actividad por sí solo: si el
   * proveedor está mapeado, la compra vuelve a heredar ese criterio.
   *
   * Queda registrado quién lo decidió y cuándo, en columnas propias y no en
   * `classifiedById` / `classifiedAt`: la actividad y las columnas Q–T son dos
   * decisiones contables distintas, tomadas en momentos distintos.
   */
  async updateDocumentActivity(
    ctx: TenantContext,
    id: string,
    dto: UpdateDocumentActivityDto,
  ): Promise<PurchaseDocumentDetailRow & { rawJson: Prisma.JsonValue | null }> {
    const tenantId = this.requireTenantId(ctx);

    await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.purchaseDocument.findFirst({
        where: { id, tenantId },
        select: { id: true, receptorId: true },
      });
      if (!existing) {
        throw new NotFoundException({
          error: 'PURCHASE_DOCUMENT_NOT_FOUND',
          message: 'Documento de compra no encontrado',
        });
      }

      // La actividad tiene que ser del MISMO contribuyente que la compra. Sin
      // esta guarda, el override sería la puerta trasera que el mapeo de
      // proveedores cierra por adelante.
      if (dto.activityId !== null) {
        await assertActivityAssignableToReceptor(tx, tenantId, dto.activityId, existing.receptorId);
      }

      await tx.purchaseDocument.update({
        where: { id },
        data: {
          activityId: dto.activityId,
          // La traza se escribe también al limpiar: "alguien decidió que esta
          // compra NO lleva override" es una decisión, y borrarla junto con el
          // id dejaría la fila indistinguible de una que nadie miró nunca.
          activityAssignedById: ctx.actor.id,
          activityAssignedAt: new Date(),
        },
      });
    });

    this.logger.info(
      { tenantId, documentId: id, activityId: dto.activityId, actorId: ctx.actor.id },
      dto.activityId === null
        ? 'Override de actividad del documento eliminado'
        : 'Override de actividad del documento asignado',
    );
    return this.findOne(ctx, id);
  }

  // -------------------------------------------------------------------------
  // Reprocesamiento
  // -------------------------------------------------------------------------

  /**
   * Encola el parseo de adjuntos JSON según el modo. Solo encola: no toca IMAP
   * ni `lastUid`, así que es seguro repetirlo cuantas veces haga falta.
   */
  async reprocess(ctx: TenantContext, dto: ReprocessDto): Promise<ReprocessResult> {
    const tenantId = this.requireTenantId(ctx);
    const limit = Math.min(
      dto.limit ?? this.config.purchaseBookReprocessBatch,
      this.config.purchaseBookReprocessBatch,
    );

    const where = buildReprocessWhere(tenantId, dto);

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.attachment.findMany({
        where,
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const enqueued = await this.enqueuer.enqueueParseBulk(
      page.map((row) => ({ tenantId, attachmentId: row.id })),
      'reprocess',
      dto.mode === 'all',
    );

    // A diferencia del sync, acá encolar ES el trabajo pedido y hay una persona
    // esperando la respuesta. `enqueueParseBulk` no lanza y devuelve cuántos
    // aceptó la cola: si aceptó menos de los que había en la página, el lote se
    // perdió y devolver `{ enqueued: 0 }` con un 201 le mentiría al operador,
    // que se iría creyendo que no había nada que reprocesar. La condición exige
    // `page.length > 0` porque "no hay nada que encolar" es un 0 legítimo.
    if (page.length > 0 && enqueued !== page.length) {
      this.logger.error(
        { tenantId, mode: dto.mode, requested: page.length, enqueued, actorId: ctx.actor.id },
        'La cola no aceptó el reprocesamiento del libro de compras; el lote se perdió',
      );
      throw new ServiceUnavailableException({
        error: 'PURCHASE_BOOK_QUEUE_UNAVAILABLE',
        message:
          'La cola de procesamiento no está aceptando trabajos; no se encoló el reprocesamiento. Reintentá más tarde.',
      });
    }

    this.logger.info(
      { tenantId, mode: dto.mode, enqueued, actorId: ctx.actor.id },
      'Reprocesamiento del libro de compras encolado',
    );

    return { enqueued, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  // -------------------------------------------------------------------------
  // Guardas
  // -------------------------------------------------------------------------

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no consulta el libro de compras de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
