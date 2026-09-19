import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACTIVITY_REF_SELECT, ActivityRefRow } from '../purchase-book.projections';
import { resolveActivity, ResolvedActivity, supplierDefaultKey } from './resolve-activity';

/**
 * Las dos consultas que la actividad efectiva necesita contra la base
 * (Addendum 11, fase 3 rebanada 2).
 *
 * Funciones sueltas y no un servicio inyectable, por la misma razón que
 * `activity-guards.ts`: no tienen estado ni dependencias y corren dentro de la
 * transacción que ya abrió `withTenant()`.
 */

/** Valor del filtro que pide "compras sin actividad resuelta". */
export const ACTIVITY_FILTER_NONE = 'none';

/** Tope de proveedores que entran en el `IN` del filtro. */
export const ACTIVITY_FILTER_MAX_SUPPLIERS = 1000;

/**
 * El filtro por actividad NO es `where activityId = X`.
 *
 * La actividad efectiva es un valor derivado: un documento pertenece a X si lo
 * dice su override, **o** si no tiene override y el default de su proveedor
 * apunta a X. Materializar un `resolvedActivityId` en el documento haría el
 * filtro trivial, pero obliga a recalcularlo cada vez que cambia un default de
 * proveedor, y un recálculo que se olvida deja datos fiscales rancios sin que
 * nada avise (Addendum 11, §"El filtro NO es where activityId = X").
 */
export type ActivityWhere = Prisma.PurchaseDocumentWhereInput;

/**
 * Traduce el `activityId` del filtro a una condición de Prisma.
 *
 * Devuelve también el `receptorId` al que hay que acotar la consulta: el mapeo
 * de proveedores es POR RECEPTOR, así que un filtro por actividad sin receptor
 * no tiene significado. Cuando se pide una actividad concreta el receptor sale
 * de la propia actividad; cuando se piden las compras sin actividad, lo tiene
 * que informar quien llama.
 */
export async function buildActivityFilter(
  tx: Prisma.TransactionClient,
  tenantId: string,
  activityId: string,
  receptorIdFromDto: string | undefined,
): Promise<{ where: ActivityWhere; receptorId: string }> {
  if (activityId === ACTIVITY_FILTER_NONE) {
    if (!receptorIdFromDto) {
      throw new NotFoundException({
        error: 'PURCHASE_ACTIVITY_RECEPTOR_REQUIRED',
        message:
          'Filtrar las compras sin actividad exige informar el receptor: el mapeo de proveedores es por contribuyente',
      });
    }
    const mapped = await mappedEmisorIds(tx, tenantId, receptorIdFromDto, null);
    return {
      receptorId: receptorIdFromDto,
      where:
        mapped.length === 0
          ? { activityId: null }
          : { activityId: null, emisorId: { notIn: mapped } },
    };
  }

  const activity = await tx.purchaseActivity.findFirst({
    where: { id: activityId, tenantId },
    select: { id: true, receptorId: true },
  });
  if (!activity) {
    throw new NotFoundException({
      error: 'PURCHASE_ACTIVITY_NOT_FOUND',
      message: 'Actividad no encontrada',
    });
  }
  if (receptorIdFromDto && receptorIdFromDto !== activity.receptorId) {
    // El receptor del filtro y el dueño de la actividad tienen que coincidir.
    // Sin esto, pedir "receptor A, actividad de B" devolvería el listado de A
    // sin filtrar por actividad, que es peor que un error: parece una respuesta.
    throw new NotFoundException({
      error: 'PURCHASE_ACTIVITY_NOT_FOUND',
      message: 'Esa actividad no es de ese contribuyente',
    });
  }

  const mapped = await mappedEmisorIds(tx, tenantId, activity.receptorId, activity.id);
  return {
    receptorId: activity.receptorId,
    where:
      mapped.length === 0
        ? { activityId: activity.id }
        : {
            OR: [{ activityId: activity.id }, { activityId: null, emisorId: { in: mapped } }],
          },
  };
}

/**
 * Proveedores mapeados de un receptor. Con `activityId` acota a los que apuntan
 * a esa actividad; con `null` devuelve todos los que tienen algún default, que
 * es lo que hace falta para negar el conjunto en el filtro "sin actividad".
 */
async function mappedEmisorIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  receptorId: string,
  activityId: string | null,
): Promise<string[]> {
  const rows = await tx.supplierActivityDefault.findMany({
    where: { tenantId, receptorId, ...(activityId ? { activityId } : {}) },
    select: { emisorId: true },
    orderBy: { emisorId: 'asc' },
    take: ACTIVITY_FILTER_MAX_SUPPLIERS,
  });
  return rows.map((row) => row.emisorId);
}

/** Un documento del listado, con su actividad efectiva ya resuelta. */
export type WithResolvedActivity<T> = T & {
  resolvedActivity: (ResolvedActivity & { activity: ActivityRefRow | null }) | null;
};

/**
 * Resuelve la actividad efectiva de una página de documentos.
 *
 * Dos consultas acotadas por el tamaño de página, no una por fila: se piden de
 * una sola vez los defaults de los pares (receptor, proveedor) que aparecen en
 * la página y sin override, y de una sola vez las actividades referenciadas.
 */
export async function attachResolvedActivity<
  T extends { activityId: string | null; emisorId: string; receptorId: string },
>(tx: Prisma.TransactionClient, tenantId: string, rows: T[]): Promise<WithResolvedActivity<T>[]> {
  if (rows.length === 0) return [];

  const pending = rows.filter((row) => row.activityId === null);
  const defaults = pending.length
    ? await tx.supplierActivityDefault.findMany({
        where: {
          tenantId,
          OR: dedupePairs(pending).map(([receptorId, emisorId]) => ({ receptorId, emisorId })),
        },
        select: { receptorId: true, emisorId: true, activityId: true },
      })
    : [];
  const defaultByPair = new Map(
    defaults.map((row) => [supplierDefaultKey(row.receptorId, row.emisorId), row.activityId]),
  );

  const resolved = rows.map((row) => ({
    row,
    activity: resolveActivity(
      row,
      defaultByPair.get(supplierDefaultKey(row.receptorId, row.emisorId)) ?? null,
    ),
  }));

  const referenced = [
    ...new Set(
      // `typeof` y no `!== null`: este arreglo va directo a un `IN` de la base.
      // El tipo dice `string | null`, pero un `undefined` que se colara por una
      // proyección incompleta pasaría un `!== null` y llegaría a Postgres.
      resolved
        .map((entry) => entry.activity.activityId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const activities = referenced.length
    ? await tx.purchaseActivity.findMany({
        where: { tenantId, id: { in: referenced } },
        select: ACTIVITY_REF_SELECT,
      })
    : [];
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));

  return resolved.map(({ row, activity }) => ({
    ...row,
    resolvedActivity:
      activity.activityId === null
        ? { ...activity, activity: null }
        : { ...activity, activity: activityById.get(activity.activityId) ?? null },
  }));
}

/** Pares (receptor, proveedor) distintos, para no repetirlos en el `OR`. */
function dedupePairs(rows: { receptorId: string; emisorId: string }[]): [string, string][] {
  const seen = new Map<string, [string, string]>();
  for (const row of rows) {
    seen.set(supplierDefaultKey(row.receptorId, row.emisorId), [row.receptorId, row.emisorId]);
  }
  return [...seen.values()];
}
