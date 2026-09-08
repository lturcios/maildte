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
 */
export function dteParseJobId(attachmentId: string): string {
  return `dte:${attachmentId}`;
}
