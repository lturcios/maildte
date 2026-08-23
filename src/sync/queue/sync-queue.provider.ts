import { Provider } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { bullmqConnectionOptions } from './bullmq-connection';
import { SYNC_QUEUE, SYNC_QUEUE_NAME, SyncJobData } from './sync-queue.constants';

export const syncQueueProvider: Provider = {
  provide: SYNC_QUEUE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Queue<SyncJobData> =>
    new Queue<SyncJobData>(SYNC_QUEUE_NAME, { connection: bullmqConnectionOptions(config) }),
};
