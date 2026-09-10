/**
 * Cola de parseo de DTE (Addendum 10, §6.2).
 *
 * Separada de la cola `sync` a propósito: el parseo es CPU + lectura de disco,
 * no toca IMAP, y su concurrencia se regula aparte con DTE_QUEUE_CONCURRENCY.
 * Un atasco parseando no puede frenar la descarga de correo.
 */

export const DTE_QUEUE_NAME = 'dte';
export const DTE_PARSE_JOB_NAME = 'dte-parse';
export const DTE_QUEUE = Symbol('DTE_QUEUE');

/** Quién encoló el job. Solo se usa para logs y métricas. */
export type DteParseTrigger = 'sync' | 'reprocess';

export interface DteParseJobData {
  tenantId: string;
  attachmentId: string;
  trigger: DteParseTrigger;
  /**
   * Re-parsea aunque ya exista un resultado terminal para el adjunto.
   * Preserva los overrides Q–T del documento (nunca los pisa).
   */
  force?: boolean;
}

/**
 * Id determinístico del job: dos encolados del mismo adjunto colapsan en uno
 * solo. Es la primera línea de idempotencia; la segunda es el ledger en
 * `DteIngestService`.
 *
 * **Cuánto dura ese colapso, que no es lo que parece.** BullMQ ignora en
 * silencio un `add`/`addBulk` cuyo `jobId` ya existe en Redis: devuelve el job
 * existente y no lo vuelve a ejecutar, sin excepción y sin aviso. Y "existe" no
 * es lo mismo que "está pendiente" — un job terminado sigue existiendo mientras
 * su cola lo retenga, y sigue absorbiendo re-encolados desde el más allá. Con la
 * retención vieja (`removeOnComplete: 500`) el colapso no duraba lo que tardaba
 * este adjunto, sino los siguientes 500 jobs completados de TODA la instalación:
 * el backfill del Addendum 11 fase 1 (producción, 2026-09-09) reportó 968
 * trabajos encolados y reprocesó 419 documentos de 862, porque 500 ids del
 * backfill del Addendum 10 seguían retenidos en Redis. No aparecía como error en
 * ninguna parte (diagnóstico en el RUNBOOK §9).
 *
 * Por eso hoy `DteEnqueuer` encola con `removeOnComplete: true` — el registro
 * durable del parseo es `dte_parse_results` en Postgres, no el historial de
 * Redis — y, como los fallos SÍ se retienen (`removeOnFail: 500`, útiles para
 * depurar), el camino de reprocesamiento borra el registro previo de cada id
 * antes de encolar. En el `sync` no: ahí el colapso mientras el job sigue
 * pendiente es justamente lo que se quiere.
 *
 * El separador es un guion, NO dos puntos: BullMQ valida el `jobId` propio y
 * rechaza los que contienen `:` salvo que tengan exactamente dos (compatibilidad
 * con los ids viejos de jobs repetibles) — `Job.validateOptions`, error
 * "Custom Id cannot contain :". Con `dte:<uuid>` el `addBulk` lanzaba,
 * `enqueueParseBulk` se tragaba la excepción (por diseño: encolar no puede
 * hacer fallar el archivado del correo) y devolvía 0, así que NINGÚN adjunto
 * llegaba nunca a la cola y el libro de compras quedaba vacío en silencio.
 */
export function dteParseJobId(attachmentId: string): string {
  return `dte-${attachmentId}`;
}
