import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EmailAccount, Prisma, SyncLog } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../prisma/prisma-errors';
import { AesService } from '../common/crypto/aes.service';
import { normalizeFolderName } from '../common/utils/normalize-folder-name';
import { StorageService } from '../storage/storage.service';
import { ImapClientFactory, ImapCredentials } from '../sync/imap/imap-client.factory';
import { IMAP_ERROR_HTTP_STATUS, ImapConnectionError } from '../sync/imap/imap-error';
import { SyncScheduler } from '../sync/sync.scheduler';
import { TenantContext } from '../common/tenancy/tenant-context';
import { CreateAccountDto } from './dto/create-account.dto';
import { ResyncAccountDto } from './dto/resync-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

const SAFE_ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  alias: true,
  email: true,
  folderName: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  imapUser: true,
  mailbox: true,
  syncInterval: true,
  syncFromDate: true,
  lastUid: true,
  uidValidity: true,
  lastSyncAt: true,
  lastError: true,
  status: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EmailAccountSelect;

type SafeAccount = Prisma.EmailAccountGetPayload<{ select: typeof SAFE_ACCOUNT_SELECT }>;

const CREDENTIAL_FIELDS = [
  'imapHost',
  'imapPort',
  'imapSecure',
  'imapUser',
  'imapPassword',
] as const;

const ACCOUNT_NOT_FOUND = { error: 'ACCOUNT_NOT_FOUND', message: 'Cuenta no encontrada' };
const ACCOUNT_EMAIL_EXISTS = {
  error: 'ACCOUNT_EMAIL_EXISTS',
  message: 'Ya existe una cuenta registrada con este correo',
};
const ACCOUNT_FOLDER_EXISTS = {
  error: 'ACCOUNT_FOLDER_EXISTS',
  message: 'Ya existe una cuenta cuyo correo normaliza al mismo nombre de carpeta',
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aes: AesService,
    private readonly imap: ImapClientFactory,
    private readonly storage: StorageService,
    private readonly scheduler: SyncScheduler,
  ) {}

  async create(dto: CreateAccountDto, ctx: TenantContext): Promise<SafeAccount> {
    const tenantId = this.requireTenantId(ctx);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxAccounts: true },
    });
    const currentCount = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.count({ where: { tenantId, deletedAt: null } }),
    );
    if (tenant && currentCount >= tenant.maxAccounts) {
      throw new UnprocessableEntityException({
        error: 'QUOTA_EXCEEDED',
        message: `Se alcanzó el límite de ${tenant.maxAccounts} cuenta(s) del plan. Ampliá el plan para agregar más.`,
      });
    }

    await this.verifyOrThrow({
      imapHost: dto.imapHost,
      imapPort: dto.imapPort,
      imapSecure: dto.imapSecure,
      imapUser: dto.imapUser,
      imapPassword: dto.imapPassword,
    });

    const imapPassEnc = this.aes.encrypt(dto.imapPassword);
    const folderName = normalizeFolderName(dto.email);

    let account: SafeAccount;
    try {
      account = await this.prisma.withTenant(tenantId, async (tx) => {
        // Chequeo previo en lugar de inferir el campo en conflicto desde
        // err.meta.target: dentro de $transaction con RLS, Postgres aborta la
        // transacción antes de que Prisma pueda resolver esos nombres de
        // columna y meta.target llega null (ver AccountsService.create).
        const conflict = await tx.emailAccount.findFirst({
          where: { tenantId, deletedAt: null, OR: [{ email: dto.email }, { folderName }] },
          select: { email: true },
        });
        if (conflict) {
          throw new ConflictException(
            conflict.email === dto.email ? ACCOUNT_EMAIL_EXISTS : ACCOUNT_FOLDER_EXISTS,
          );
        }

        return tx.emailAccount.create({
          data: {
            tenantId,
            alias: dto.alias,
            email: dto.email,
            folderName,
            imapHost: dto.imapHost,
            imapPort: dto.imapPort,
            imapSecure: dto.imapSecure,
            imapUser: dto.imapUser,
            imapPassEnc,
            mailbox: dto.mailbox ?? 'INBOX',
            ...(dto.syncInterval !== undefined ? { syncInterval: dto.syncInterval } : {}),
            ...(dto.syncFromDate !== undefined ? { syncFromDate: new Date(dto.syncFromDate) } : {}),
          },
          select: SAFE_ACCOUNT_SELECT,
        });
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        throw err;
      }
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException(ACCOUNT_EMAIL_EXISTS);
      }
      throw err;
    }

    await this.storage.ensureAccountFolder(ctx.tenantSlug!, folderName);
    await this.scheduler.syncRepeatableFor(account);

    return account;
  }

  async findAll(ctx: TenantContext): Promise<SafeAccount[]> {
    const tenantId = this.requireTenantId(ctx);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findMany({
        where: this.whereActive(tenantId),
        select: SAFE_ACCOUNT_SELECT,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async findOne(ctx: TenantContext, id: string): Promise<SafeAccount & { syncLogs: SyncLog[] }> {
    const tenantId = this.requireTenantId(ctx);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const account = await tx.emailAccount.findFirst({
        where: this.whereActive(tenantId, { id }),
        select: SAFE_ACCOUNT_SELECT,
      });
      if (!account) {
        throw new NotFoundException(ACCOUNT_NOT_FOUND);
      }

      const syncLogs = await tx.syncLog.findMany({
        where: { tenantId, accountId: id },
        orderBy: { startedAt: 'desc' },
        take: 5,
      });

      return { ...account, syncLogs };
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateAccountDto): Promise<SafeAccount> {
    const tenantId = this.requireTenantId(ctx);

    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: this.whereActive(tenantId, { id }) }),
    );
    if (!existing) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }

    const credentialsChanged = CREDENTIAL_FIELDS.some((field) => dto[field] !== undefined);

    if (credentialsChanged) {
      await this.verifyOrThrow({
        imapHost: dto.imapHost ?? existing.imapHost,
        imapPort: dto.imapPort ?? existing.imapPort,
        imapSecure: dto.imapSecure ?? existing.imapSecure,
        imapUser: dto.imapUser ?? existing.imapUser,
        imapPassword: dto.imapPassword ?? this.aes.decrypt(existing.imapPassEnc),
      });
    }

    const data: Prisma.EmailAccountUpdateInput = {
      ...(dto.alias !== undefined ? { alias: dto.alias } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.imapHost !== undefined ? { imapHost: dto.imapHost } : {}),
      ...(dto.imapPort !== undefined ? { imapPort: dto.imapPort } : {}),
      ...(dto.imapSecure !== undefined ? { imapSecure: dto.imapSecure } : {}),
      ...(dto.imapUser !== undefined ? { imapUser: dto.imapUser } : {}),
      ...(dto.imapPassword !== undefined
        ? { imapPassEnc: this.aes.encrypt(dto.imapPassword) }
        : {}),
      ...(dto.mailbox !== undefined ? { mailbox: dto.mailbox } : {}),
      ...(dto.syncInterval !== undefined ? { syncInterval: dto.syncInterval } : {}),
    };

    if (dto.status !== undefined) {
      data.status = dto.status;
    } else if (credentialsChanged && existing.status === 'ERROR_AUTH') {
      data.status = 'ACTIVA';
    }

    let updated: SafeAccount;
    try {
      updated = await this.prisma.withTenant(tenantId, async (tx) => {
        if (dto.email !== undefined && dto.email !== existing.email) {
          const conflict = await tx.emailAccount.findFirst({
            where: { tenantId, deletedAt: null, email: dto.email, id: { not: id } },
            select: { id: true },
          });
          if (conflict) {
            throw new ConflictException(ACCOUNT_EMAIL_EXISTS);
          }
        }
        return tx.emailAccount.update({ where: { id }, data, select: SAFE_ACCOUNT_SELECT });
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        throw err;
      }
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException(ACCOUNT_EMAIL_EXISTS);
      }
      throw err;
    }

    if (credentialsChanged && existing.status === 'ERROR_AUTH' && updated.status === 'ACTIVA') {
      await this.scheduler.resetAuthFailures(id);
    }
    await this.scheduler.syncRepeatableFor(updated);

    return updated;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const tenantId = this.requireTenantId(ctx);

    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: this.whereActive(tenantId, { id }) }),
    );
    if (!existing) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'INACTIVA' },
      }),
    );
    await this.scheduler.removeRepeatable(id);
  }

  async triggerManualSync(ctx: TenantContext, id: string): Promise<{ enqueued: true }> {
    const tenantId = this.requireTenantId(ctx);
    const account = await this.requireSyncableAccount(tenantId, id);

    await this.scheduler.enqueueManual(tenantId, account.id);
    return { enqueued: true };
  }

  /**
   * Cambia el punto de partida de la cuenta y fuerza una re-sincronización
   * completa: syncFromDate nuevo + lastSyncAt: null hace que el próximo sync
   * entre por la rama de "primera sincronización" (sync.service.ts,
   * resolveFirstSyncStartUid) y vuelva a recorrer el buzón desde esa fecha.
   * Es seguro reprocesar ese rango: el constraint (accountId, messageId)
   * hace que los correos ya archivados se detecten como duplicados en vez de
   * descargarse dos veces.
   */
  async resyncFrom(
    ctx: TenantContext,
    id: string,
    dto: ResyncAccountDto,
  ): Promise<{ enqueued: true }> {
    const tenantId = this.requireTenantId(ctx);
    const account = await this.requireSyncableAccount(tenantId, id);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.update({
        where: { id: account.id },
        data: { syncFromDate: new Date(dto.syncFromDate), lastSyncAt: null },
      }),
    );

    await this.scheduler.enqueueManual(tenantId, account.id);
    return { enqueued: true };
  }

  async testConnection(ctx: TenantContext, id: string): Promise<{ ok: true; latencyMs: number }> {
    const tenantId = this.requireTenantId(ctx);

    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: this.whereActive(tenantId, { id }) }),
    );
    if (!account) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }

    const { latencyMs } = await this.verifyOrThrow({
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      imapUser: account.imapUser,
      imapPassword: this.aes.decrypt(account.imapPassEnc),
    });

    return { ok: true, latencyMs };
  }

  private whereActive(
    tenantId: string,
    extra: Prisma.EmailAccountWhereInput = {},
  ): Prisma.EmailAccountWhereInput {
    return { tenantId, deletedAt: null, ...extra };
  }

  /** Cuenta existente, del tenant, activa: precondición compartida por triggerManualSync y resyncFrom. */
  private async requireSyncableAccount(tenantId: string, id: string): Promise<EmailAccount> {
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: this.whereActive(tenantId, { id }) }),
    );
    if (!account) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }
    if (account.status !== 'ACTIVA') {
      throw new UnprocessableEntityException({
        error: 'ACCOUNT_NOT_SYNCABLE',
        message: `La cuenta está en estado ${account.status} y no puede sincronizarse`,
      });
    }
    return account;
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no gestiona cuentas de correo de negocio',
      });
    }
    return ctx.tenantId;
  }

  private async verifyOrThrow(credentials: ImapCredentials): Promise<{ latencyMs: number }> {
    try {
      return await this.imap.verifyConnection(credentials);
    } catch (err) {
      if (err instanceof ImapConnectionError) {
        throw new HttpException(
          { error: err.code, message: err.message },
          IMAP_ERROR_HTTP_STATUS[err.code],
        );
      }
      throw err;
    }
  }
}
