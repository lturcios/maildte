import { Module } from '@nestjs/common';
import { SyncQueueModule } from './queue/sync-queue.module';
import { ImapModule } from './imap/imap.module';
import { StorageModule } from '../storage/storage.module';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';

@Module({
  imports: [SyncQueueModule, ImapModule, StorageModule],
  providers: [SyncService, SyncProcessor],
  exports: [SyncService],
})
export class SyncModule {}
