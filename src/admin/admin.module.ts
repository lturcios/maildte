import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { SyncQueueModule } from '../sync/queue/sync-queue.module';

@Module({
  imports: [SyncQueueModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
