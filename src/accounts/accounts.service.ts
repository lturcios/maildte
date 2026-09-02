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
import { ImapEndpoint, resolveImapEndpoint } from '../sync/imap/resolve-imap-endpoint';
import { SyncScheduler } from '../sync/sync.scheduler';
import { TenantContext } from '../common/tenancy/tenant-context';
import { CreateAccountDto } from './dto/create-account.dto';
import { ResyncAccountDto } from './dto/resync-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

/**
 * Datos del perfil que se exponen junto a la cuenta. La tabla no tiene secretos,
 * pero se seleccionan campo por campo igual que el resto del proyecto: el
 * frontend necesita el endpoint efectivo, `strict` para la advertencia al
 * cambiarlo y notes/helpUrl para explicar el requisito de autenticación.
 */
const SAFE_PROVIDER_SELECT = {
  id: true,
  key: true,
  name: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  defaultMailbox: true,
  strict: true,
  notes: true,
  helpUrl: true,
  active: true,
} satisfies Prisma.MailProviderSelect;

const SAFE_ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  alias: true,
  email: true,
  folderName: true,
  providerId: true,
  provider: { select: SAFE_PROVIDER_SELECT },
  // Con providerId != null estas tres columnas NO son la configuración vigente
  // (manda el perfil): quedan como último endpoint escrito y como punto de
  // partida si la cuenta se desvincula. El valor efectivo sale siempre de
  // resolveImapEndpoint().
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

/** Campos que, al cambiar, obligan a revalidar la conexión IMAP antes de guardar. */
const CREDENTIAL_FIELDS = [
  'providerId',
  'imapHost',
  'imapPort',
  'imapSecure',
  'imapUser',
  'imapPassword',
] as const;

const ACCOUNT_NOT_FOUND = { error: 'ACCOUNT_NOT_FOUND', message: 'Cuenta no encontrada' };
const PROVIDER_NOT_FOUND = {
  error: 'PROVIDER_NOT_FOUND',
  message: 'El servicio de correo seleccionado no existe o está deshabilitado',
};
const IMAP_ENDPOINT_REQUIRED = {
  error: 'IMAP_ENDPOINT_REQUIRED',
  message:
    'Sin un servicio de correo seleccionado hay que indicar servidor IMAP, puerto y uso de TLS/SSL',
};
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

    const { providerId, endpoint } = await this.resolveWriteEndpoint(dto.providerId ?? null, {
      imapHost: dto.imapHost,
      imapPort: dto.imapPort,
      imapSecure: dto.imapSecure,
    });

    await this.verifyOrThrow({
      ...endpoint,
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
            providerId,
            // Las columnas imap* se persisten con el endpoint efectivo al momento
            // del alta: son NOT NULL, y si la cuenta se desvincula del perfil más
            // adelante quedan como punto de partida sensato. Mientras haya
            // providerId, nadie las lee (resolveImapEndpoint).
            ...endpoint,
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

    // El vínculo con el perfil solo cambia si el PATCH trae la clave: ausente
    // deja lo que hay, un UUID vincula, null desvincula (ver UpdateAccountDto).
    // Al desvincular sin mandar host/puerto/TLS, el endpoint efectivo de este
    // momento queda congelado en las columnas propias: "soltar el perfil y
    // quedarse como está" es lo menos sorpresivo.
    const nextProviderId =
      dto.providerId !== undefined ? dto.providerId : (existing.providerId ?? null);
    const { providerId, endpoint } = await this.resolveWriteEndpoint(nextProviderId, {
      imapHost: dto.imapHost ?? existing.imapHost,
      imapPort: dto.imapPort ?? existing.imapPort,
      imapSecure: dto.imapSecure ?? existing.imapSecure,
    });

    if (credentialsChanged) {
      await this.verifyOrThrow({
        ...endpoint,
        imapUser: dto.imapUser ?? existing.imapUser,
        imapPassword: dto.imapPassword ?? this.aes.decrypt(existing.imapPassEnc),
      });
    }

    const data: Prisma.EmailAccountUpdateInput = {
      ...(dto.alias !== undefined ? { alias: dto.alias } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(credentialsChanged
        ? {
            ...endpoint,
            provider: providerId ? { connect: { id: providerId } } : { disconnect: true },
          }
        : {}),
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

    // include del perfil: la prueba tiene que usar el mismo endpoint que va a
    // usar el sync, no las columnas propias de la cuenta (Addendum 09).
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({
        where: this.whereActive(tenantId, { id }),
        include: { provider: true },
      }),
    );
    if (!account) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }

    const { latencyMs } = await this.verifyOrThrow({
      ...resolveImapEndpoint(account),
      imapUser: account.imapUser,
      imapPassword: this.aes.decrypt(account.imapPassEnc),
    });

    return { ok: true, latencyMs };
  }

  /**
   * Resuelve el endpoint efectivo de un alta o edición y valida la coherencia
   * del par (perfil, columnas propias). Con perfil, el catálogo manda y las
   * columnas se ignoran; sin perfil, las tres columnas son obligatorias.
   *
   * Lee `mail_providers` fuera de withTenant a propósito: es un catálogo global
   * sin tenantId y sin RLS (ver la migración mail_providers).
   */
  private async resolveWriteEndpoint(
    providerId: string | null,
    own: Partial<ImapEndpoint>,
  ): Promise<{ providerId: string | null; endpoint: ImapEndpoint }> {
    if (providerId !== null) {
      const provider = await this.prisma.mailProvider.findFirst({
        where: { id: providerId, active: true },
        select: { imapHost: true, imapPort: true, imapSecure: true },
      });
      if (!provider) {
        throw new UnprocessableEntityException(PROVIDER_NOT_FOUND);
      }
      // Misma regla que resolveImapEndpoint: con perfil, las columnas propias
      // que venga trayendo el DTO se descartan.
      return {
        providerId,
        endpoint: {
          imapHost: provider.imapHost,
          imapPort: provider.imapPort,
          imapSecure: provider.imapSecure,
        },
      };
    }

    if (own.imapHost === undefined || own.imapPort === undefined || own.imapSecure === undefined) {
      throw new UnprocessableEntityException(IMAP_ENDPOINT_REQUIRED);
    }
    return {
      providerId: null,
      endpoint: {
        imapHost: own.imapHost,
        imapPort: own.imapPort,
        imapSecure: own.imapSecure,
      },
    };
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
