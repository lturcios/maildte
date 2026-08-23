import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { StorageModule } from '../storage/storage.module';
import { ImapModule } from '../sync/imap/imap.module';
import { SyncQueueModule } from '../sync/queue/sync-queue.module';

@Module({
  imports: [StorageModule, ImapModule, SyncQueueModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
