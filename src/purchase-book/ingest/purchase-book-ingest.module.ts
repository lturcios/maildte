import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { DteIngestService } from './dte-ingest.service';
import { DteParseProcessor } from './dte-parse.processor';

/**
 * Lado consumidor del libro de compras. Lo importa SOLO WorkerModule: la API
 * encola trabajos (DteQueueModule) pero nunca los procesa, igual que con el sync.
 */
@Module({
  imports: [StorageModule],
  providers: [DteIngestService, DteParseProcessor],
  exports: [DteIngestService],
})
export class PurchaseBookIngestModule {}
