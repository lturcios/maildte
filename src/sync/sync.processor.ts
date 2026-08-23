import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import { bullmqConnectionOptions } from './queue/bullmq-connection';
import { SYNC_QUEUE_NAME, SyncJobData } from './queue/sync-queue.constants';
import { SyncService } from './sync.service';

const CONCURRENCY = 3;

@Injectable()
export class SyncProcessor implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker<SyncJobData>;

  constructor(
    private readonly syncService: SyncService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncProcessor.name);
  }

  onModuleInit(): void {
    this.worker = new Worker<SyncJobData>(
      SYNC_QUEUE_NAME,
      async (job: Job<SyncJobData>) => {
        await this.syncService.syncAccount(job.data.tenantId, job.data.accountId, job.data.trigger);
      },
      { connection: bullmqConnectionOptions(this.config), concurrency: CONCURRENCY },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { accountId: job?.data?.accountId, jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        'Job de sincronización falló',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
