export const SYNC_QUEUE_NAME = 'sync';
export const SYNC_JOB_NAME = 'sync-account';
export const SYNC_QUEUE = Symbol('SYNC_QUEUE');

export type SyncTrigger = 'scheduler' | 'manual';

export interface SyncJobData {
  tenantId: string;
  accountId: string;
  trigger: SyncTrigger;
}
