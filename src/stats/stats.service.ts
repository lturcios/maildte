import { ForbiddenException, Injectable } from '@nestjs/common';
import { EmailStatus, SyncLog } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';

interface AccountFileTotals {
  accountId: string;
  filesCount: bigint;
  totalBytes: bigint | null;
}

interface AccountMonthFileTotals {
  accountId: string;
  monthFolder: string;
  filesCount: bigint;
  totalBytes: bigint | null;
}

export interface AccountSummary {
  accountId: string;
  emailsByStatus: Partial<Record<EmailStatus, number>>;
  totalEmails: number;
  filesCount: number;
  totalBytes: number;
}

export interface AccountMonthSummary {
  accountId: string;
  monthFolder: string;
  emailsCount: number;
  filesCount: number;
  totalBytes: number;
}

export interface StatsSummary {
  byAccount: AccountSummary[];
  byAccountMonth: AccountMonthSummary[];
  recentErrors: SyncLog[];
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ctx: TenantContext): Promise<StatsSummary> {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no consulta datos de negocio de un tenant por esta ruta (ver /admin)',
      });
    }
    const tenantId = ctx.tenantId;

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);

    const [
      emailsByAccount,
      filesByAccount,
      emailsByAccountMonth,
      filesByAccountMonth,
      recentErrors,
    ] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.processedEmail.groupBy({
          by: ['accountId', 'status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        tx.$queryRaw<AccountFileTotals[]>`
              SELECT pe."accountId" as "accountId",
                     COUNT(a.id) as "filesCount",
                     COALESCE(SUM(a."sizeBytes"), 0) as "totalBytes"
              FROM "attachments" a
              JOIN "processed_emails" pe ON pe.id = a."emailId"
              WHERE pe."tenantId" = ${tenantId}
              GROUP BY pe."accountId"
            `,
        tx.processedEmail.groupBy({
          by: ['accountId', 'monthFolder'],
          _count: { _all: true },
          where: { tenantId, receivedAt: { gte: twelveMonthsAgo } },
        }),
        tx.$queryRaw<AccountMonthFileTotals[]>`
              SELECT pe."accountId" as "accountId",
                     pe."monthFolder" as "monthFolder",
                     COUNT(a.id) as "filesCount",
                     COALESCE(SUM(a."sizeBytes"), 0) as "totalBytes"
              FROM "attachments" a
              JOIN "processed_emails" pe ON pe.id = a."emailId"
              WHERE pe."tenantId" = ${tenantId} AND pe."receivedAt" >= ${twelveMonthsAgo}
              GROUP BY pe."accountId", pe."monthFolder"
            `,
        tx.syncLog.findMany({
          where: { tenantId, status: 'ERROR' },
          orderBy: { startedAt: 'desc' },
          take: 10,
        }),
      ]),
    );

    return {
      byAccount: this.mergeByAccount(emailsByAccount, filesByAccount),
      byAccountMonth: this.mergeByAccountMonth(emailsByAccountMonth, filesByAccountMonth),
      recentErrors,
    };
  }

  private mergeByAccount(
    emailsByAccount: { accountId: string; status: EmailStatus; _count: { _all: number } }[],
    filesByAccount: AccountFileTotals[],
  ): AccountSummary[] {
    const byId = new Map<string, AccountSummary>();

    const entryFor = (accountId: string): AccountSummary => {
      let entry = byId.get(accountId);
      if (!entry) {
        entry = { accountId, emailsByStatus: {}, totalEmails: 0, filesCount: 0, totalBytes: 0 };
        byId.set(accountId, entry);
      }
      return entry;
    };

    for (const row of emailsByAccount) {
      const entry = entryFor(row.accountId);
      entry.emailsByStatus[row.status] = row._count._all;
      entry.totalEmails += row._count._all;
    }
    for (const row of filesByAccount) {
      const entry = entryFor(row.accountId);
      entry.filesCount = Number(row.filesCount);
      entry.totalBytes = Number(row.totalBytes ?? 0);
    }

    return Array.from(byId.values());
  }

  private mergeByAccountMonth(
    emailsByAccountMonth: { accountId: string; monthFolder: string; _count: { _all: number } }[],
    filesByAccountMonth: AccountMonthFileTotals[],
  ): AccountMonthSummary[] {
    const byKey = new Map<string, AccountMonthSummary>();
    const keyOf = (accountId: string, monthFolder: string): string => `${accountId}:${monthFolder}`;

    const entryFor = (accountId: string, monthFolder: string): AccountMonthSummary => {
      const key = keyOf(accountId, monthFolder);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { accountId, monthFolder, emailsCount: 0, filesCount: 0, totalBytes: 0 };
        byKey.set(key, entry);
      }
      return entry;
    };

    for (const row of emailsByAccountMonth) {
      const entry = entryFor(row.accountId, row.monthFolder);
      entry.emailsCount += row._count._all;
    }
    for (const row of filesByAccountMonth) {
      const entry = entryFor(row.accountId, row.monthFolder);
      entry.filesCount = Number(row.filesCount);
      entry.totalBytes = Number(row.totalBytes ?? 0);
    }

    return Array.from(byKey.values());
  }
}
