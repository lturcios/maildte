import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { bullmqConnectionOptions } from '../../sync/queue/bullmq-connection';
import { DTE_QUEUE_NAME, DteParseJobData } from '../queue/dte-queue.constants';
import { DteIngestService } from './dte-ingest.service';

/**
 * Consumidor de la cola `dte` (Addendum 10, §6.5).
 *
 * Mismo patrón que SyncProcessor: Worker de BullMQ creado a mano en
 * onModuleInit. Se registra SOLO en WorkerModule; la API encola pero no consume.
 */
@Injectable()
export class DteParseProcessor implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker<DteParseJobData>;

  constructor(
    private readonly ingest: DteIngestService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DteParseProcessor.name);
  }

  onModuleInit(): void {
    this.worker = new Worker<DteParseJobData>(
      DTE_QUEUE_NAME,
      async (job: Job<DteParseJobData>) => {
        await this.ingest.ingestAttachment(job.data.tenantId, job.data.attachmentId, {
          force: job.data.force ?? false,
        });
      },
      {
        connection: bullmqConnectionOptions(this.config),
        concurrency: this.config.dteQueueConcurrency,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        {
          tenantId: job?.data?.tenantId,
          attachmentId: job?.data?.attachmentId,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
          err,
        },
        'Job de parseo de DTE falló',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
