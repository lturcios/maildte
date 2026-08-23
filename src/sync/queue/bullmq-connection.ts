import { ConnectionOptions } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';

/** BullMQ exige maxRetriesPerRequest: null en las conexiones de Queue y Worker. */
export function bullmqConnectionOptions(config: AppConfigService): ConnectionOptions {
  return { url: config.redisUrl, maxRetriesPerRequest: null };
}
