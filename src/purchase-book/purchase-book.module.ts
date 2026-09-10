import { Module } from '@nestjs/common';
import { DteQueueModule } from './queue/dte-queue.module';
import { PurchaseBookController } from './purchase-book.controller';
import { PurchaseBookService } from './purchase-book.service';
import { PartiesService } from './parties.service';
import { ExportPurchaseBookService } from './export/export-purchase-book.service';
import { PurchaseActivityService } from './activity/purchase-activity.service';
import { PurchaseActivitySeedService } from './activity/purchase-activity-seed.service';

/**
 * Lado API del libro de compras. Importa DteQueueModule para poder ENCOLAR el
 * reprocesamiento, pero no registra el processor: consumir la cola es exclusivo
 * del worker (PurchaseBookIngestModule).
 */
@Module({
  imports: [DteQueueModule],
  controllers: [PurchaseBookController],
  providers: [
    PurchaseBookService,
    PartiesService,
    ExportPurchaseBookService,
    PurchaseActivityService,
    PurchaseActivitySeedService,
  ],
  exports: [PurchaseBookService],
})
export class PurchaseBookModule {}
