import { Module } from '@nestjs/common';
import { SyncQueueModule } from './queue/sync-queue.module';
import { SyncBootstrap } from './sync-bootstrap.service';

/** Exclusivo del proceso API: importar solo desde AppModule, nunca desde WorkerModule/SyncModule. */
@Module({
  imports: [SyncQueueModule],
  providers: [SyncBootstrap],
})
export class SyncBootstrapModule {}
