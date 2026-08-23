import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { SYNC_JOB_NAME, SYNC_QUEUE, SyncJobData } from './queue/sync-queue.constants';
import { authFailKey } from './auth-fail-key';

const RETRY_OPTIONS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 30_000 } };

export interface SchedulableAccount {
  id: string;
  tenantId: string;
  syncInterval: number;
  status: string;
  deletedAt: Date | null;
}

/**
 * Gestiona el ciclo de vida de los jobs BullMQ de una cuenta. Usado tanto por el proceso
 * API (AccountsService, al crear/actualizar/borrar cuentas, y AdminService al suspender o
 * reactivar un tenant) como por el proceso worker (SyncService, para remover el repetible
 * al llegar a ERROR_AUTH). El registro al bootstrap vive aparte, en SyncBootstrap, exclusivo
 * del proceso API.
 */
@Injectable()
export class SyncScheduler {
  constructor(
    @Inject(SYNC_QUEUE) private readonly queue: Queue<SyncJobData>,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncScheduler.name);
  }

  /** Idempotente: re-registrar una cuenta ya programada solo actualiza su intervalo. */
  async registerRepeatable(
    account: Pick<SchedulableAccount, 'id' | 'tenantId' | 'syncInterval'>,
  ): Promise<void> {
    await this.queue.add(
      SYNC_JOB_NAME,
      { tenantId: account.tenantId, accountId: account.id, trigger: 'scheduler' },
      {
        repeat: { every: account.syncInterval * 1000, key: account.id },
        jobId: `sync:${account.id}`,
        removeOnComplete: 100,
        removeOnFail: 100,
        ...RETRY_OPTIONS,
      },
    );
  }

  async removeRepeatable(accountId: string): Promise<void> {
    await this.queue.removeRepeatableByKey(accountId);
  }

  /** Sincroniza el estado del job repetible con el estado real de la cuenta (upsert o remove). */
  async syncRepeatableFor(account: SchedulableAccount): Promise<void> {
    if (!account.deletedAt && account.status === 'ACTIVA') {
      await this.registerRepeatable(account);
    } else {
      await this.removeRepeatable(account.id);
    }
  }

  async enqueueManual(tenantId: string, accountId: string): Promise<void> {
    await this.queue.add(
      SYNC_JOB_NAME,
      { tenantId, accountId, trigger: 'manual' },
      { attempts: 1 },
    );
  }

  /** Recuperación tras ERROR_AUTH: limpia el contador de fallos consecutivos. */
  async resetAuthFailures(accountId: string): Promise<void> {
    await this.redis.del(authFailKey(accountId));
  }
}
