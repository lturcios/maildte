import { Provider } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { bullmqConnectionOptions } from '../../sync/queue/bullmq-connection';
import { DTE_QUEUE, DTE_QUEUE_NAME, DteParseJobData } from './dte-queue.constants';

export const dteQueueProvider: Provider = {
  provide: DTE_QUEUE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Queue<DteParseJobData> =>
    new Queue<DteParseJobData>(DTE_QUEUE_NAME, {
      connection: bullmqConnectionOptions(config),
    }),
};
