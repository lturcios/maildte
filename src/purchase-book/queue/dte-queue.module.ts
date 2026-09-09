import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { dteQueueProvider } from './dte-queue.provider';
import { DTE_QUEUE, DteParseJobData } from './dte-queue.constants';
import { DteEnqueuer } from './dte-enqueuer';

/** Cierra la conexión de la Queue al apagar el módulo (igual que SyncQueueLifecycle). */
@Injectable()
class DteQueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(DTE_QUEUE) private readonly queue: Queue<DteParseJobData>) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

@Module({
  providers: [dteQueueProvider, DteEnqueuer, DteQueueLifecycle],
  exports: [DTE_QUEUE, DteEnqueuer],
})
export class DteQueueModule {}
