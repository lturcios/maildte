import { Module } from '@nestjs/common';
import { DteQueueModule } from './queue/dte-queue.module';
import { PurchaseBookController } from './purchase-book.controller';
import { PurchaseBookService } from './purchase-book.service';
import { PartiesService } from './parties.service';

/**
 * Lado API del libro de compras. Importa DteQueueModule para poder ENCOLAR el
 * reprocesamiento, pero no registra el processor: consumir la cola es exclusivo
 * del worker (PurchaseBookIngestModule).
 */
@Module({
  imports: [DteQueueModule],
  controllers: [PurchaseBookController],
  providers: [PurchaseBookService, PartiesService],
  exports: [PurchaseBookService],
})
export class PurchaseBookModule {}
