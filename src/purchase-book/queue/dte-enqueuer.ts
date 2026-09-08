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
      this.logger.warn(
        { err, count: targets.length, trigger },
        'No se pudo encolar el parseo de DTE; se recuperará con el reprocesamiento',
      );
      return 0;
    }
  }
}
