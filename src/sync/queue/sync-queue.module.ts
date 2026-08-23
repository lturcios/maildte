import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { syncQueueProvider } from './sync-queue.provider';
import { SYNC_QUEUE, SyncJobData } from './sync-queue.constants';
import { SyncScheduler } from '../sync.scheduler';

/** Cierra la conexión de la Queue al apagar el módulo (mismo motivo que RedisLifecycle). */
@Injectable()
class SyncQueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(SYNC_QUEUE) private readonly queue: Queue<SyncJobData>) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

@Module({
  providers: [syncQueueProvider, SyncScheduler, SyncQueueLifecycle],
  exports: [SYNC_QUEUE, SyncScheduler],
})
export class SyncQueueModule {}
