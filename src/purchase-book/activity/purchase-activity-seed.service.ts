import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ApplyActivitySeedDto, ProposeActivitySeedDto } from '../dto/activity-seed.dto';
import { assertReceptorExists } from './activity-guards';

/**
 * Tope de grupos que puede devolver una agregación de la propuesta.
 *
 * La siembra existe para un contribuyente con decenas de proveedores (30 en el
 * caso que cerró la §7.4). Si las combinaciones superan este tope, recortar la
 * agregación devolvería un "código más frecuente" calculado sobre una muestra
 * arbitraria: una propuesta silenciosamente equivocada. Se prefiere un 422 que
 * dice que la siembra no aplica a ese volumen.
 */
export const SEED_MAX_GROUPS = 2000;

/** Una actividad propuesta a partir de los códigos vistos en los DTE. */
export interface ProposedActivity {
  /** Código CIIU que declara el proveedor. Es la clave de la propuesta. */
  codActividad: string;
  /** Descripción del DTE, que se ofrece como nombre de la actividad. */
  nombre: string;
  /** Compras del receptor que declaran este código. */
  documentCount: number;
}

/** Un proveedor propuesto, con la actividad que declara con más frecuencia. */
export interface ProposedSupplierMapping {
  emisorId: string;
  emisorNit: string;
  emisorNombre: string;
  codActividad: string;
  activityNombre: string;
  /** Compras totales de ese proveedor a este receptor: ordena la lista. */
  documentCount: number;
  /** Cuántas de esas compras declaran el código elegido. */
  matchingCount: number;
}

export interface ActivitySeedProposal {
  receptorId: string;
  activities: ProposedActivity[];
  mappings: ProposedSupplierMapping[];
  /** Compras sin `receptorCodActividad`: no participan de la propuesta. */
  documentsWithoutActivity: number;
}

export interface ActivitySeedApplyResult {
  receptorId: string;
  activitiesCreated: number;
  activitiesSkipped: number;
  mappingsCreated: number;
  mappingsSkipped: number;
  /**
   * Nombres ya presentes en el catálogo cuando arrancó el lote: la segunda
   * corrida no los duplica.
   *
   * Es el detalle del caso normal. En una carrera —dos `apply()` a la vez— el
   * conteo `activitiesSkipped` puede ser mayor que esta lista: `createMany` con
   * `skipDuplicates` informa cuántas filas insertó, pero no cuáles descartó, y
   * fabricar la diferencia sería inventar un dato.
   */
  skippedActivityNames: string[];
  /** Proveedores que ya tenían default: no se pisa una decisión ya tomada. */
  skippedEmisorIds: string[];
}

/** Fila cruda de la agregación por código y descripción. */
interface CodeGroup {
  receptorCodActividad: string | null;
  receptorDescActividad: string | null;
  _count: { _all: number };
}

/** Fila cruda de la agregación por proveedor y código. */
interface SupplierCodeGroup {
  emisorId: string;
  receptorCodActividad: string | null;
  _count: { _all: number };
}

/**
 * Siembra del catálogo y del mapeo (Addendum 11, fase 3).
 *
 * Dos pasos deliberadamente separados:
 *
 *   1. `propose()` — SOLO LECTURA. Deriva la propuesta de los snapshots
 *      `receptorCodActividad` / `receptorDescActividad` que ya viven en
 *      `purchase_documents`. No escribe absolutamente nada.
 *   2. `apply()` — escribe lo que el contador revisó, con `confirm: true`.
 *
 * La separación no es una comodidad de UI: el contador fusiona códigos que son
 * el mismo negocio con dos etiquetas y descarta los que no le sirven, y
 * CLAUDE.md prohíbe que el código de aplicación escriba datos en masa sin un
 * flag explícito.
 */
@Injectable()
export class PurchaseActivitySeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PurchaseActivitySeedService.name);
  }

  // -------------------------------------------------------------------------
  // Propuesta (solo lectura)
  // -------------------------------------------------------------------------

  async propose(ctx: TenantContext, dto: ProposeActivitySeedDto): Promise<ActivitySeedProposal> {
    const tenantId = this.requireTenantId(ctx);
    const receptorId = dto.receptorId;

    const proposal = await this.prisma.withTenant(tenantId, async (tx) => {
      await assertReceptorExists(tx, tenantId, receptorId);

      const withCode: Prisma.PurchaseDocumentWhereInput = {
        tenantId,
        receptorId,
        receptorCodActividad: { not: null },
      };

      const [codeGroups, supplierGroups, supplierTotals, documentsWithoutActivity] =
        await Promise.all([
          tx.purchaseDocument.groupBy({
            by: ['receptorCodActividad', 'receptorDescActividad'],
            where: withCode,
            _count: { _all: true },
          }),
          tx.purchaseDocument.groupBy({
            by: ['emisorId', 'receptorCodActividad'],
            where: withCode,
            _count: { _all: true },
          }),
          tx.purchaseDocument.groupBy({
            by: ['emisorId'],
            where: { tenantId, receptorId },
            _count: { _all: true },
          }),
          tx.purchaseDocument.count({
            where: { tenantId, receptorId, receptorCodActividad: null },
          }),
        ]);

      this.assertWithinSeedLimits(codeGroups.length, supplierGroups.length);

      const activities = buildProposedActivities(codeGroups);
      const activityNameByCode = new Map(
        activities.map((activity) => [activity.codActividad, activity.nombre]),
      );
      const totalByEmisor = new Map(supplierTotals.map((row) => [row.emisorId, row._count._all]));

      const chosen = chooseCodePerSupplier(supplierGroups);
      const emisorIds = [...chosen.keys()];
      const parties =
        emisorIds.length === 0
          ? []
          : await tx.dteParty.findMany({
              where: { tenantId, id: { in: emisorIds } },
              select: { id: true, nit: true, nombre: true },
            });
      const partyById = new Map(parties.map((party) => [party.id, party]));

      const mappings: ProposedSupplierMapping[] = emisorIds
        .map((emisorId) => {
          const pick = chosen.get(emisorId);
          const party = partyById.get(emisorId);
          // Un proveedor sin fila en el catálogo no puede pasar: `emisorId` es
          // FK NOT NULL de purchase_documents. Se filtra igual para no fabricar
          // un nombre vacío si alguna vez deja de serlo.
          if (!pick || !party) return null;
          return {
            emisorId,
            emisorNit: party.nit,
            emisorNombre: party.nombre,
            codActividad: pick.codActividad,
            activityNombre: activityNameByCode.get(pick.codActividad) ?? pick.codActividad,
            documentCount: totalByEmisor.get(emisorId) ?? pick.count,
            matchingCount: pick.count,
          };
        })
        .filter((row): row is ProposedSupplierMapping => row !== null)
        .sort(compareProposedMappings);

      return { receptorId, activities, mappings, documentsWithoutActivity };
    });

    this.logger.info(
      {
        tenantId,
        receptorId,
        actividades: proposal.activities.length,
        mapeos: proposal.mappings.length,
        sinActividad: proposal.documentsWithoutActivity,
        actorId: ctx.actor.id,
      },
      'Propuesta de siembra de actividades calculada',
    );
    return proposal;
  }

  // -------------------------------------------------------------------------
  // Aplicación
  // -------------------------------------------------------------------------

  /**
   * Escribe la propuesta revisada. Idempotente: una segunda corrida no duplica
   * nada, porque una actividad ya existente por nombre y un proveedor que ya
   * tiene default se saltean y se reportan en el resultado. Saltear en vez de
   * pisar es deliberado: la segunda corrida no puede deshacer una corrección
   * manual del contador.
   *
   * Todo el lote va en una sola transacción (`withTenant` ya lo es): un catálogo
   * a medias con el mapeo de la primera mitad sería peor que no haber aplicado
   * nada.
   *
   * **Se escribe con `createMany`, no con un `create` por fila.** El lote llega
   * a `SEED_MAX_ACTIVITIES` + `SEED_MAX_MAPPINGS` filas y `withTenant()` no
   * cambia el timeout por defecto de una transacción interactiva de Prisma
   * (5 s): 1200 idas y vueltas secuenciales contra una base que no está en
   * localhost lo superan y el lote entero muere con un error sin traducir.
   * Acá son dos INSERT y una relectura del catálogo.
   *
   * `skipDuplicates` además hace que la idempotencia deje de ser un
   * "consultar y después escribir" —dos `apply()` simultáneos hacían que el
   * segundo se estrellara con un P2002 crudo y revirtiera todo el lote— y pase
   * a ser un `ON CONFLICT DO NOTHING` que la base resuelve de una sola vez.
   */
  async apply(ctx: TenantContext, dto: ApplyActivitySeedDto): Promise<ActivitySeedApplyResult> {
    const tenantId = this.requireTenantId(ctx);
    const receptorId = dto.receptorId;

    const activities = dto.activities.map((activity) => ({
      ...activity,
      nombre: activity.nombre.trim(),
    }));
    assertNoDuplicates(
      activities.map((activity) => activity.nombre),
      'PURCHASE_BOOK_SEED_DUPLICATE_ACTIVITY',
      'La propuesta repite el nombre de una actividad. Fusionalas antes de aplicar.',
    );
    assertNoDuplicates(
      dto.mappings.map((mapping) => mapping.emisorId),
      'PURCHASE_BOOK_SEED_DUPLICATE_SUPPLIER',
      'La propuesta asigna dos actividades al mismo proveedor. Un proveedor tiene un solo default por receptor.',
    );

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      await assertReceptorExists(tx, tenantId, receptorId);

      // --- catálogo ---
      const existing = await tx.purchaseActivity.findMany({
        where: { tenantId, receptorId },
        select: { id: true, nombre: true },
      });
      const idByName = new Map(existing.map((row) => [row.nombre, row.id]));

      const skippedActivityNames = activities
        .filter((activity) => idByName.has(activity.nombre))
        .map((activity) => activity.nombre);
      const toCreate = activities.filter((activity) => !idByName.has(activity.nombre));

      let activitiesCreated = 0;
      if (toCreate.length > 0) {
        const inserted = await tx.purchaseActivity.createMany({
          data: toCreate.map((activity) => ({
            tenantId,
            receptorId,
            nombre: activity.nombre,
            codActividad: activity.codActividad ?? null,
            defaultTipoOperacion: activity.defaultTipoOperacion ?? null,
            defaultClasificacion: activity.defaultClasificacion ?? null,
            defaultSector: activity.defaultSector ?? null,
            defaultTipoCostoGasto: activity.defaultTipoCostoGasto ?? null,
          })),
          skipDuplicates: true,
        });
        activitiesCreated = inserted.count;

        // `createMany` no devuelve ids y los mapeos referencian la actividad por
        // NOMBRE: se relee el catálogo del receptor una sola vez para rearmar
        // nombre -> id. Trae también lo que haya insertado un `apply()`
        // concurrente, que es justo lo que hace falta para no dejar un mapeo
        // sin actividad.
        const catalog = await tx.purchaseActivity.findMany({
          where: { tenantId, receptorId },
          select: { id: true, nombre: true },
        });
        for (const row of catalog) idByName.set(row.nombre, row.id);
      }

      // --- mapeo ---
      const skippedEmisorIds: string[] = [];
      let mappingsCreated = 0;

      if (dto.mappings.length > 0) {
        const emisorIds = dto.mappings.map((mapping) => mapping.emisorId);

        const parties = await tx.dteParty.findMany({
          where: { tenantId, id: { in: emisorIds } },
          select: { id: true },
        });
        const known = new Set(parties.map((party) => party.id));
        const unknown = emisorIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw new NotFoundException({
            error: 'DTE_PARTY_NOT_FOUND',
            message: `La propuesta referencia ${unknown.length} proveedor(es) que no existen en este tenant`,
          });
        }

        const alreadyMapped = await tx.supplierActivityDefault.findMany({
          where: { tenantId, receptorId, emisorId: { in: emisorIds } },
          select: { emisorId: true },
        });
        const mappedEmisores = new Set(alreadyMapped.map((row) => row.emisorId));

        const assignedAt = new Date();
        const rows: Prisma.SupplierActivityDefaultCreateManyInput[] = [];

        for (const mapping of dto.mappings) {
          const activityNombre = mapping.activityNombre.trim();
          const activityId = idByName.get(activityNombre);
          if (!activityId) {
            throw new UnprocessableEntityException({
              error: 'PURCHASE_BOOK_SEED_UNKNOWN_ACTIVITY',
              message: `El mapeo apunta a la actividad "${activityNombre}", que no está en la propuesta ni en el catálogo del contribuyente`,
            });
          }
          if (mappedEmisores.has(mapping.emisorId)) {
            skippedEmisorIds.push(mapping.emisorId);
            continue;
          }
          rows.push({
            tenantId,
            receptorId,
            emisorId: mapping.emisorId,
            activityId,
            assignedById: ctx.actor.id,
            assignedAt,
          });
        }

        if (rows.length > 0) {
          // `skipDuplicates` sobre `@@unique([tenantId, receptorId, emisorId])`:
          // el proveedor que otro `apply()` mapeó mientras tanto se descarta en
          // la base, no se pisa. "Saltear, nunca romper, nunca duplicar" deja
          // de depender de que nadie escriba entre la consulta y el INSERT.
          const inserted = await tx.supplierActivityDefault.createMany({
            data: rows,
            skipDuplicates: true,
          });
          mappingsCreated = inserted.count;
        }
      }

      return {
        receptorId,
        activitiesCreated,
        // Creadas + salteadas siempre suma el lote completo, también cuando un
        // `apply()` concurrente se adelantó con alguna fila.
        activitiesSkipped: activities.length - activitiesCreated,
        mappingsCreated,
        mappingsSkipped: dto.mappings.length - mappingsCreated,
        skippedActivityNames,
        skippedEmisorIds,
      };
    });

    this.logger.info(
      {
        tenantId,
        receptorId,
        actividadesCreadas: result.activitiesCreated,
        actividadesOmitidas: result.activitiesSkipped,
        mapeosCreados: result.mappingsCreated,
        mapeosOmitidos: result.mappingsSkipped,
        actorId: ctx.actor.id,
      },
      'Siembra de actividades aplicada',
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // Guardas
  // -------------------------------------------------------------------------

  private assertWithinSeedLimits(codeGroups: number, supplierGroups: number): void {
    if (codeGroups <= SEED_MAX_GROUPS && supplierGroups <= SEED_MAX_GROUPS) return;
    throw new UnprocessableEntityException({
      error: 'PURCHASE_BOOK_SEED_TOO_LARGE',
      message: `El histórico de este contribuyente tiene demasiadas combinaciones de proveedor y actividad (más de ${SEED_MAX_GROUPS}) para proponer una siembra. Armá el catálogo a mano y usá la clasificación masiva.`,
    });
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no siembra el catálogo de actividades de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}

/**
 * Una actividad propuesta por cada código distinto.
 *
 * El nombre sale de la descripción que más veces acompaña a ese código: el
 * mismo código puede venir con textos distintos según el emisor del DTE.
 * DESEMPATE, en orden: mayor cantidad de documentos, luego la descripción
 * alfabéticamente ascendente. Sin el segundo criterio, dos descripciones con la
 * misma frecuencia harían que la propuesta cambiara entre corridas según el
 * orden que devolviera la base.
 */
function buildProposedActivities(groups: CodeGroup[]): ProposedActivity[] {
  const byCode = new Map<string, { nombre: string; nombreCount: number; total: number }>();

  for (const group of groups) {
    const codActividad = group.receptorCodActividad;
    if (codActividad === null) continue;
    const count = group._count._all;
    // Sin descripción el nombre propuesto es el propio código: nunca se inventa
    // un texto que el contador no vio en sus documentos.
    const nombre = group.receptorDescActividad?.trim() || codActividad;

    const current = byCode.get(codActividad);
    if (!current) {
      byCode.set(codActividad, { nombre, nombreCount: count, total: count });
      continue;
    }
    current.total += count;
    const better =
      count > current.nombreCount ||
      (count === current.nombreCount && nombre.localeCompare(current.nombre) < 0);
    if (better) {
      current.nombre = nombre;
      current.nombreCount = count;
    }
  }

  return [...byCode.entries()]
    .map(([codActividad, value]) => ({
      codActividad,
      nombre: value.nombre,
      documentCount: value.total,
    }))
    .sort((a, b) => {
      if (a.documentCount !== b.documentCount) return b.documentCount - a.documentCount;
      return a.codActividad.localeCompare(b.codActividad);
    });
}

/**
 * Código que cada proveedor declara con más frecuencia.
 *
 * DESEMPATE: a igual cantidad de documentos gana el código menor en orden
 * lexicográfico. Es arbitrario a propósito, pero determinista: dos corridas
 * sobre los mismos datos proponen exactamente lo mismo, y el contador corrige
 * el caso raro en la revisión.
 */
function chooseCodePerSupplier(
  groups: SupplierCodeGroup[],
): Map<string, { codActividad: string; count: number }> {
  const chosen = new Map<string, { codActividad: string; count: number }>();

  for (const group of groups) {
    const codActividad = group.receptorCodActividad;
    if (codActividad === null) continue;
    const count = group._count._all;

    const current = chosen.get(group.emisorId);
    if (!current) {
      chosen.set(group.emisorId, { codActividad, count });
      continue;
    }
    const better =
      count > current.count ||
      (count === current.count && codActividad.localeCompare(current.codActividad) < 0);
    if (better) chosen.set(group.emisorId, { codActividad, count });
  }

  return chosen;
}

/** Volumen descendente; a igual volumen, nombre y luego id del proveedor. */
function compareProposedMappings(a: ProposedSupplierMapping, b: ProposedSupplierMapping): number {
  if (a.documentCount !== b.documentCount) return b.documentCount - a.documentCount;
  const byName = a.emisorNombre.localeCompare(b.emisorNombre);
  if (byName !== 0) return byName;
  return a.emisorId.localeCompare(b.emisorId);
}

function assertNoDuplicates(values: string[], error: string, message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new UnprocessableEntityException({ error, message });
    }
    seen.add(value);
  }
}
