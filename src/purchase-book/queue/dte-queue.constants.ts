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
 * mientras el primero siga en la cola. Es la primera línea de idempotencia;
 * la segunda es el ledger en `DteIngestService`.
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
