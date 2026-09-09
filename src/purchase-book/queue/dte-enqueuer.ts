import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Queue } from 'bullmq';
import {
  DTE_PARSE_JOB_NAME,
  DTE_QUEUE,
  DteParseJobData,
  dteParseJobId,
  DteParseTrigger,
} from './dte-queue.constants';

/** Reintentos con backoff exponencial: los fallos de infraestructura se reintentan. */
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_MS = 30_000;
const KEEP_COMPLETED = 500;
const KEEP_FAILED = 500;

export interface EnqueueParseTarget {
  tenantId: string;
  attachmentId: string;
}

/**
 * Encola trabajos de parseo de DTE (Addendum 10, §6.2).
 *
 * Vive en la API y en el worker: el sync encola tras persistir un correo y el
 * backfill encola lotes desde el endpoint de reprocesamiento.
 */
@Injectable()
export class DteEnqueuer {
  constructor(
    @Inject(DTE_QUEUE) private readonly queue: Queue<DteParseJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DteEnqueuer.name);
  }

  /**
   * Encola varios adjuntos de una sola llamada a Redis.
   *
   * No lanza: encolar es una optimización, no una garantía. Si Redis está
   * caído, el correo ya quedó archivado y el backfill (`mode=missing`) recupera
   * lo que no se encoló. Reventar acá marcaría como ERROR un correo que se
   * descargó bien.
   *
   * **Devuelve cuántos trabajos aceptó la cola. Un valor menor que
   * `targets.length` significa que el lote SE PERDIÓ y TODO llamador está
   * obligado a comparar el retorno contra lo que pidió.** No hacerlo es
   * exactamente lo que dejó al libro de compras vacío en silencio: un `jobId`
   * con `:` hacía lanzar a `addBulk`, este método se tragaba la excepción y
   * devolvía 0, y nadie miraba el número (ver `dteParseJobId`).
   */
  async enqueueParseBulk(
    targets: EnqueueParseTarget[],
    trigger: DteParseTrigger,
    force = false,
  ): Promise<number> {
    if (targets.length === 0) return 0;

    try {
      await this.queue.addBulk(
        targets.map((target) => ({
          name: DTE_PARSE_JOB_NAME,
          data: { ...target, trigger, force },
          opts: {
            jobId: dteParseJobId(target.attachmentId),
            attempts: JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
            removeOnComplete: KEEP_COMPLETED,
            removeOnFail: KEEP_FAILED,
          },
        })),
      );
      return targets.length;
    } catch (err) {
      // ERROR y no WARN a propósito: un lote que nunca llega a la cola es una
      // falla, y el único aviso de que el libro de compras se está quedando
      // vacío. WARN no dispara alertas; nadie lo mira.
      this.logger.error(
        { err, count: targets.length, trigger, force },
        'No se pudo encolar el parseo de DTE; el lote se perdió y se recuperará con el reprocesamiento',
      );
      return 0;
    }
  }
}
