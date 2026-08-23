import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { AttachmentsController } from './attachments.controller';
import { SyncLogsController } from './sync-logs.controller';
import { SyncLogsService } from './sync-logs.service';

@Module({
  imports: [StorageModule],
  controllers: [EmailsController, AttachmentsController, SyncLogsController],
  providers: [EmailsService, SyncLogsService],
})
export class EmailsModule {}
