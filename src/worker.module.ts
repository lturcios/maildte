import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { SyncModule } from './sync/sync.module';

/**
 * Raíz del proceso worker: SOLO consume la cola BullMQ, nunca expone HTTP.
 * No importa AccountsModule/HealthModule/guards — eso es exclusivo de AppModule (API).
 */
@Module({
  imports: [CoreModule, SyncModule],
})
export class WorkerModule {}
