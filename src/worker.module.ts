import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { SyncModule } from './sync/sync.module';
import { PurchaseBookIngestModule } from './purchase-book/ingest/purchase-book-ingest.module';

/**
 * Raíz del proceso worker: SOLO consume la cola BullMQ, nunca expone HTTP.
 * No importa AccountsModule/HealthModule/guards — eso es exclusivo de AppModule (API).
 */
@Module({
  imports: [CoreModule, SyncModule, PurchaseBookIngestModule],
})
export class WorkerModule {}
