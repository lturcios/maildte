import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ListPurchaseActivitiesDto } from '../dto/list-purchase-activities.dto';
import { CreatePurchaseActivityDto } from '../dto/create-purchase-activity.dto';
import { UpdatePurchaseActivityDto } from '../dto/update-purchase-activity.dto';
import {
  ClearSupplierActivityDefaultDto,
  ListSupplierActivityDefaultsDto,
  SetSupplierActivityDefaultDto,
} from '../dto/supplier-activity-default.dto';
import {
  ACTIVITY_SELECT,
  PurchaseActivityRow,
  SUPPLIER_ACTIVITY_DEFAULT_SELECT,
  SupplierActivityDefaultRow,
} from '../purchase-book.projections';
import { assertReceptorExists } from './activity-guards';

/**
 * Tope del mapeo que se devuelve de una vez.
 *
 * El mapeo de un contribuyente son decenas de filas —30 en el caso que originó
 * el addendum— y se ordena por volumen de compras, que es un dato que no vive
 * en la tabla: paginar en la base daría un orden alfabético inútil o un orden
 * por volumen calculado sobre una página arbitraria. Se recorta acá, con un
 * `take` explícito, en vez de dejar un `findMany` abierto.
 */
export const SUPPLIER_DEFAULTS_MAX_ROWS = 500;

/** Una fila del mapeo con el volumen de compras que la ordena. */
export type SupplierActivityDefaultWithVolume = SupplierActivityDefaultRow & {
  documentCount: number;
};

/**
 * Catálogo de actividades del contribuyente y mapeo de proveedores
 * (Addendum 11, fase 3).
 *
 * Las dos tablas son POR RECEPTOR: la actividad es la unidad de negocio de un
 * contribuyente concreto y el default de un proveedor es el criterio de ese
 * contribuyente. Ninguna operación acepta trabajar sin `receptorId`.
 */
@Injectable()
export class PurchaseActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PurchaseActivityService.name);
  }

  // -------------------------------------------------------------------------
  // Catálogo
  // -------------------------------------------------------------------------

  async findAll(
    ctx: TenantContext,
    dto: ListPurchaseActivitiesDto,
  ): Promise<PurchaseActivityRow[]> {
    const tenantId = this.requireTenantId(ctx);

    const where: Prisma.PurchaseActivityWhereInput = { tenantId, receptorId: dto.receptorId };
    if (!dto.includeInactive) where.active = true;

    if (dto.q) {
      const contains = dto.q.trim();
      if (contains.length > 0) {
        where.OR = [
          { nombre: { contains, mode: 'insensitive' } },
          { codActividad: { contains, mode: 'insensitive' } },
        ];
      }
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.purchaseActivity.findMany({
        where,
        select: ACTIVITY_SELECT,
        orderBy: [{ active: 'desc' }, { nombre: 'asc' }],
        take: dto.limit,
      }),
    );
  }

  async create(ctx: TenantContext, dto: CreatePurchaseActivityDto): Promise<PurchaseActivityRow> {
    const tenantId = this.requireTenantId(ctx);

    const activity = await this.prisma.withTenant(tenantId, async (tx) => {
      await assertReceptorExists(tx, tenantId, dto.receptorId);
      try {
        return await tx.purchaseActivity.create({
          data: {
            tenantId,
            receptorId: dto.receptorId,
            nombre: dto.nombre.trim(),
            codActividad: dto.codActividad ?? null,
            defaultTipoOperacion: dto.defaultTipoOperacion ?? null,
            defaultClasificacion: dto.defaultClasificacion ?? null,
            defaultSector: dto.defaultSector ?? null,
            defaultTipoCostoGasto: dto.defaultTipoCostoGasto ?? null,
          },
          select: ACTIVITY_SELECT,
        });
      } catch (err: unknown) {
        throw this.translateActivityWriteError(err);
      }
    });

    this.logger.info(
      { tenantId, receptorId: dto.receptorId, activityId: activity.id, actorId: ctx.actor.id },
      'Actividad del catálogo creada',
    );
    return activity;
  }

  /** PATCH parcial: solo se escriben las claves presentes en el body. */
  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdatePurchaseActivityDto,
  ): Promise<PurchaseActivityRow> {
    const tenantId = this.requireTenantId(ctx);

    const data: Prisma.PurchaseActivityUpdateInput = {};
    if (dto.nombre !== undefined) data.nombre = dto.nombre.trim();
    if ('codActividad' in dto) data.codActividad = dto.codActividad ?? null;
    if (dto.active !== undefined) data.active = dto.active;
    if ('defaultTipoOperacion' in dto) data.defaultTipoOperacion = dto.defaultTipoOperacion ?? null;
    if ('defaultClasificacion' in dto) data.defaultClasificacion = dto.defaultClasificacion ?? null;
    if ('defaultSector' in dto) data.defaultSector = dto.defaultSector ?? null;
    if ('defaultTipoCostoGasto' in dto) {
      data.defaultTipoCostoGasto = dto.defaultTipoCostoGasto ?? null;
    }

    const activity = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.findOwnActivity(tx, tenantId, id);
      try {
        return await tx.purchaseActivity.update({ where: { id }, data, select: ACTIVITY_SELECT });
      } catch (err: unknown) {
        throw this.translateActivityWriteError(err);
      }
    });

    this.logger.info(
      { tenantId, receptorId: activity.receptorId, activityId: id, actorId: ctx.actor.id },
      'Actividad del catálogo actualizada',
    );
    return activity;
  }

  /**
   * Retiro de una actividad. `active = false` conserva el mapeo y los overrides
   * que la referencian: la actividad deja de ofrecerse sin que nada quede
   * apuntando al vacío. Es la operación que reemplaza al DELETE.
   */
  async deactivate(ctx: TenantContext, id: string): Promise<PurchaseActivityRow> {
    const tenantId = this.requireTenantId(ctx);

    const activity = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.findOwnActivity(tx, tenantId, id);
      try {
        return await tx.purchaseActivity.update({
          where: { id },
          data: { active: false },
          select: ACTIVITY_SELECT,
        });
      } catch (err: unknown) {
        throw this.translateActivityWriteError(err);
      }
    });

    this.logger.info(
      { tenantId, receptorId: activity.receptorId, activityId: id, actorId: ctx.actor.id },
      'Actividad del catálogo desactivada',
    );
    return activity;
  }

  /**
   * Borrado definitivo, permitido SOLO si nada la referencia.
   *
   * Una actividad referenciada por el mapeo de un proveedor o por el override
   * de un documento no se borra: el borrado deja el mapeo apuntando al vacío,
   * que es la falla que el addendum señala explícitamente al hablar de la
   * fusión de actividades. En ese caso la respuesta es un 422 que dirige a
   * desactivarla.
   *
   * La base dice lo mismo: las dos FK a `purchase_activities` son
   * `ON DELETE RESTRICT`, así que una referencia que aparezca DESPUÉS de estos
   * dos conteos —una carrera— hace fallar el DELETE con P2003 y se traduce al
   * mismo 422, en vez de llegar como un 500.
   */
  async remove(ctx: TenantContext, id: string): Promise<{ id: string; deleted: true }> {
    const tenantId = this.requireTenantId(ctx);

    const receptorId = await this.prisma.withTenant(tenantId, async (tx) => {
      const activity = await this.findOwnActivity(tx, tenantId, id);

      const [mappings, documents] = await Promise.all([
        tx.supplierActivityDefault.count({ where: { tenantId, activityId: id } }),
        tx.purchaseDocument.count({ where: { tenantId, activityId: id } }),
      ]);

      if (mappings > 0 || documents > 0) {
        throw new UnprocessableEntityException({
          error: 'PURCHASE_ACTIVITY_IN_USE',
          message: `La actividad está en uso por ${mappings} proveedor(es) y ${documents} compra(s). Desactivala en vez de borrarla: borrarla dejaría ese mapeo apuntando a una actividad inexistente.`,
        });
      }

      try {
        await tx.purchaseActivity.delete({ where: { id } });
      } catch (err: unknown) {
        throw this.translateActivityDeleteError(err);
      }
      return activity.receptorId;
    });

    this.logger.info(
      { tenantId, receptorId, activityId: id, actorId: ctx.actor.id },
      'Actividad del catálogo eliminada',
    );
    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Mapeo (proveedor, receptor) -> actividad
  // -------------------------------------------------------------------------

  /**
   * Mapeo del receptor, ordenado por VOLUMEN DE COMPRAS descendente y no
   * alfabéticamente (nota de UI del addendum, §7.4): si un proveedor concentra
   * 400 compras y veinte tienen 3, mapear los primeros ya cubre casi todo. El
   * orden vive acá para que la pantalla lo reciba resuelto.
   */
  async findSupplierDefaults(
    ctx: TenantContext,
    dto: ListSupplierActivityDefaultsDto,
  ): Promise<SupplierActivityDefaultWithVolume[]> {
    const tenantId = this.requireTenantId(ctx);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await assertReceptorExists(tx, tenantId, dto.receptorId);

      const rows = await tx.supplierActivityDefault.findMany({
        where: { tenantId, receptorId: dto.receptorId },
        select: SUPPLIER_ACTIVITY_DEFAULT_SELECT,
        // Orden estable para que el recorte por `take` sea determinista; el
        // orden que ve el usuario se calcula abajo, con el volumen.
        orderBy: { emisorId: 'asc' },
        take: SUPPLIER_DEFAULTS_MAX_ROWS,
      });
      if (rows.length === 0) return [];

      const volumes = await tx.purchaseDocument.groupBy({
        by: ['emisorId'],
        where: {
          tenantId,
          receptorId: dto.receptorId,
          emisorId: { in: rows.map((row) => row.emisorId) },
        },
        _count: { _all: true },
      });
      const countByEmisor = new Map(volumes.map((row) => [row.emisorId, row._count._all]));

      return rows
        .map((row) => ({ ...row, documentCount: countByEmisor.get(row.emisorId) ?? 0 }))
        .sort(compareBySupplierVolume);
    });
  }

  /**
   * Define (o reemplaza) la actividad por defecto de un proveedor para un
   * receptor.
   *
   * Verifica que la actividad sea del MISMO tenant y del MISMO receptor antes
   * de escribir. Un mapeo apuntando a la actividad de otro contribuyente es la
   * fuga que este modelo ternario existe para impedir: aplicaría el criterio de
   * una empresa a las compras de otra.
   */
  async setSupplierDefault(
    ctx: TenantContext,
    dto: SetSupplierActivityDefaultDto,
  ): Promise<SupplierActivityDefaultRow> {
    const tenantId = this.requireTenantId(ctx);

    const mapping = await this.prisma.withTenant(tenantId, async (tx) => {
      await assertReceptorExists(tx, tenantId, dto.receptorId);
      await this.assertEmisorExists(tx, tenantId, dto.emisorId);
      await this.assertActivityBelongsToReceptor(tx, tenantId, dto.activityId, dto.receptorId);

      return tx.supplierActivityDefault.upsert({
        where: {
          tenantId_receptorId_emisorId: {
            tenantId,
            receptorId: dto.receptorId,
            emisorId: dto.emisorId,
          },
        },
        create: {
          tenantId,
          receptorId: dto.receptorId,
          emisorId: dto.emisorId,
          activityId: dto.activityId,
          assignedById: ctx.actor.id,
          assignedAt: new Date(),
        },
        update: {
          activityId: dto.activityId,
          assignedById: ctx.actor.id,
          assignedAt: new Date(),
        },
        select: SUPPLIER_ACTIVITY_DEFAULT_SELECT,
      });
    });

    this.logger.info(
      {
        tenantId,
        receptorId: dto.receptorId,
        emisorId: dto.emisorId,
        activityId: dto.activityId,
        actorId: ctx.actor.id,
      },
      'Actividad por defecto del proveedor definida',
    );
    return mapping;
  }

  /**
   * Quita el default de un proveedor. Las compras de ese proveedor sin override
   * quedan sin actividad, que es el estado "sin clasificar" de la cascada, no
   * un error.
   */
  async clearSupplierDefault(
    ctx: TenantContext,
    dto: ClearSupplierActivityDefaultDto,
  ): Promise<{ receptorId: string; emisorId: string; deleted: true }> {
    const tenantId = this.requireTenantId(ctx);

    await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.supplierActivityDefault.findFirst({
        where: { tenantId, receptorId: dto.receptorId, emisorId: dto.emisorId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          error: 'SUPPLIER_ACTIVITY_DEFAULT_NOT_FOUND',
          message: 'Ese proveedor no tiene una actividad por defecto para este receptor',
        });
      }
      await tx.supplierActivityDefault.delete({ where: { id: existing.id } });
    });

    this.logger.info(
      { tenantId, receptorId: dto.receptorId, emisorId: dto.emisorId, actorId: ctx.actor.id },
      'Actividad por defecto del proveedor eliminada',
    );
    return { receptorId: dto.receptorId, emisorId: dto.emisorId, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Guardas
  // -------------------------------------------------------------------------

  private async findOwnActivity(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<{ id: string; receptorId: string }> {
    // `tenantId` explícito además de RLS: defensa en profundidad, igual que en
    // el resto del módulo.
    const activity = await tx.purchaseActivity.findFirst({
      where: { id, tenantId },
      select: { id: true, receptorId: true },
    });
    if (!activity) {
      throw new NotFoundException({
        error: 'PURCHASE_ACTIVITY_NOT_FOUND',
        message: 'Actividad no encontrada',
      });
    }
    return activity;
  }

  private async assertEmisorExists(
    tx: Prisma.TransactionClient,
    tenantId: string,
    emisorId: string,
  ): Promise<void> {
    const party = await tx.dteParty.findFirst({
      where: { id: emisorId, tenantId },
      select: { id: true },
    });
    if (!party) {
      throw new NotFoundException({
        error: 'DTE_PARTY_NOT_FOUND',
        message: 'Proveedor no encontrado',
      });
    }
  }

  private async assertActivityBelongsToReceptor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    activityId: string,
    receptorId: string,
  ): Promise<void> {
    const activity = await tx.purchaseActivity.findFirst({
      where: { id: activityId, tenantId },
      select: { id: true, receptorId: true, active: true },
    });
    if (!activity) {
      throw new NotFoundException({
        error: 'PURCHASE_ACTIVITY_NOT_FOUND',
        message: 'Actividad no encontrada',
      });
    }
    if (activity.receptorId !== receptorId) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_ACTIVITY_RECEPTOR_MISMATCH',
        message:
          'La actividad pertenece a otro contribuyente. El mapeo de proveedores es por receptor: apuntar a la actividad de otro aplicaría su criterio a estas compras.',
      });
    }
    if (!activity.active) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_ACTIVITY_INACTIVE',
        message: 'La actividad está desactivada: reactivala antes de asignarla a un proveedor',
      });
    }
  }

  /**
   * Traduce los errores de Prisma que una escritura sobre el catálogo puede
   * devolver, para que ninguno llegue al filtro genérico como un 500.
   *
   * - **P2002** sobre `@@unique([tenantId, receptorId, nombre])`: el nombre ya
   *   está tomado en ese contribuyente.
   * - **P2025**: la fila desapareció entre la comprobación de pertenencia
   *   (`findOwnActivity`) y la escritura. Es una carrera real —dos pestañas del
   *   panel, un borrado concurrente— y el resultado correcto es el mismo 404
   *   que habría devuelto la comprobación un instante después, no un
   *   "Ocurrió un error interno inesperado".
   *
   * Cualquier otro error se devuelve tal cual: traducir a ciegas escondería un
   * fallo de infraestructura detrás de un mensaje de negocio.
   */
  private translateActivityWriteError(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        return new ConflictException({
          error: 'PURCHASE_ACTIVITY_NAME_EXISTS',
          message: 'Ese contribuyente ya tiene una actividad con ese nombre',
        });
      }
      if (err.code === 'P2025') {
        return new NotFoundException({
          error: 'PURCHASE_ACTIVITY_NOT_FOUND',
          message: 'Actividad no encontrada',
        });
      }
    }
    return err;
  }

  /**
   * Lo mismo para el DELETE, más el caso que solo puede darse ahí: **P2003**,
   * la violación de las FK `ON DELETE RESTRICT` de `purchase_documents` y de
   * `supplier_activity_defaults`. Significa que algo empezó a referenciar la
   * actividad entre los dos conteos de `remove()` y el borrado, así que la
   * respuesta correcta es el mismo 422 que devuelven esos conteos.
   */
  private translateActivityDeleteError(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return new UnprocessableEntityException({
        error: 'PURCHASE_ACTIVITY_IN_USE',
        message:
          'La actividad quedó en uso mientras se la borraba. Desactivala en vez de borrarla: borrarla dejaría ese mapeo apuntando a una actividad inexistente.',
      });
    }
    return this.translateActivityWriteError(err);
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no administra el catálogo de actividades de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}

/**
 * Volumen descendente; a igual volumen, nombre del proveedor y luego su id,
 * para que el orden sea determinista y no dependa del orden de la base.
 */
function compareBySupplierVolume(
  a: SupplierActivityDefaultWithVolume,
  b: SupplierActivityDefaultWithVolume,
): number {
  if (a.documentCount !== b.documentCount) return b.documentCount - a.documentCount;
  const byName = a.emisor.nombre.localeCompare(b.emisor.nombre);
  if (byName !== 0) return byName;
  return a.emisorId.localeCompare(b.emisorId);
}
