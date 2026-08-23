import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { SYNC_QUEUE, SyncJobData } from './queue/sync-queue.constants';
import { SchedulableAccount, SyncScheduler } from './sync.scheduler';

/**
 * Registra los jobs repetibles de las cuentas ACTIVAS al arrancar. Exclusivo del proceso
 * API (AppModule) — el worker nunca debe registrar/reconciliar repetibles, solo consumirlos.
 *
 * `email_accounts` tiene RLS FORCE: no hay una única query "todas las cuentas de todos los
 * tenants". Se itera por tenant ACTIVO y se consulta cada uno con withTenant — análogo al
 * patrón ya usado en AdminService.usage(), nunca una conexión que bypasee RLS (skill tenancy).
 */
@Injectable()
export class SyncBootstrap implements OnApplicationBootstrap {
  constructor(
    @Inject(SYNC_QUEUE) private readonly queue: Queue<SyncJobData>,
    private readonly scheduler: SyncScheduler,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncBootstrap.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVO' },
      select: { id: true },
    });

    const activeAccounts: SchedulableAccount[] = [];
    for (const tenant of activeTenants) {
      const accounts = await this.prisma.withTenant(tenant.id, (tx) =>
        tx.emailAccount.findMany({
          where: { tenantId: tenant.id, deletedAt: null, status: 'ACTIVA' },
          select: { id: true, tenantId: true, syncInterval: true, status: true, deletedAt: true },
        }),
      );
      activeAccounts.push(...accounts);
    }
    const activeIds = new Set(activeAccounts.map((a) => a.id));

    const repeatables = await this.queue.getRepeatableJobs();
    for (const job of repeatables) {
      if (!activeIds.has(job.key)) {
        await this.queue.removeRepeatableByKey(job.key);
        this.logger.warn({ jobKey: job.key }, 'Job repetible huérfano removido al bootstrap');
      }
    }

    for (const account of activeAccounts) {
      await this.scheduler.registerRepeatable(account);
    }

    this.logger.info({ count: activeAccounts.length }, 'Jobs repetibles registrados al bootstrap');
  }
}
