import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { AesService } from '../common/crypto/aes.service';
import { StorageService } from '../storage/storage.service';
import { ImapClientFactory } from '../sync/imap/imap-client.factory';
import { ImapConnectionError } from '../sync/imap/imap-error';
import { SyncScheduler } from '../sync/sync.scheduler';
import { TenantContext } from '../common/tenancy/tenant-context';
import { CreateAccountDto } from './dto/create-account.dto';

const TENANT_ID = 'tenant-1';
const TENANT_CTX: TenantContext = {
  tenantId: TENANT_ID,
  tenantSlug: 'tenant-1-slug',
  actor: { type: 'user', id: 'user-1', role: 'ADMIN' },
};

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  emailAccount: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  syncLog: {
    findMany: jest.fn(),
  },
  tenant: {
    findUnique: jest.fn(),
  },
  withTenant: jest.fn(callWithTenantMock),
};

function uniqueEmailViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: ['email'] },
  });
}

// Reproduce el caso real: dentro de $transaction con RLS, Postgres aborta la
// transacción antes de que Prisma resuelva las columnas del constraint y
// meta.target llega null en vez de un array.
function uniqueViolationWithNullTarget(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { modelName: 'EmailAccount', target: null },
  });
}

describe('AccountsService', () => {
  let service: AccountsService;
  let aes: { encrypt: jest.Mock; decrypt: jest.Mock };
  let imap: { verifyConnection: jest.Mock };
  let storage: { ensureAccountFolder: jest.Mock };
  let scheduler: {
    syncRepeatableFor: jest.Mock;
    removeRepeatable: jest.Mock;
    enqueueManual: jest.Mock;
    resetAuthFailures: jest.Mock;
  };

  const baseDto: CreateAccountDto = {
    alias: 'Compras Casa Matriz',
    email: 'compras@ltsoft.us',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    imapUser: 'compras@ltsoft.us',
    imapPassword: 'app-password-secreto',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    aes = {
      encrypt: jest.fn((value: string) => `enc(${value})`),
      decrypt: jest.fn((value: string) => value.replace(/^enc\(|\)$/g, '')),
    };
    imap = { verifyConnection: jest.fn().mockResolvedValue({ latencyMs: 42 }) };
    storage = { ensureAccountFolder: jest.fn().mockResolvedValue(undefined) };
    scheduler = {
      syncRepeatableFor: jest.fn().mockResolvedValue(undefined),
      removeRepeatable: jest.fn().mockResolvedValue(undefined),
      enqueueManual: jest.fn().mockResolvedValue(undefined),
      resetAuthFailures: jest.fn().mockResolvedValue(undefined),
    };
    prismaMock.tenant.findUnique.mockResolvedValue({ maxAccounts: 3 });
    prismaMock.emailAccount.count.mockResolvedValue(0);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AesService, useValue: aes },
        { provide: ImapClientFactory, useValue: imap },
        { provide: StorageService, useValue: storage },
        { provide: SyncScheduler, useValue: scheduler },
      ],
    }).compile();

    service = moduleRef.get(AccountsService);
  });

  describe('create', () => {
    it('persiste la cuenta con la credencial cifrada cuando la conexión IMAP es válida', async () => {
      prismaMock.emailAccount.create.mockResolvedValue({
        id: 'acc-1',
        folderName: 'compras_ltsoft_us',
      });

      const result = await service.create(baseDto, TENANT_CTX);

      expect(imap.verifyConnection).toHaveBeenCalledWith(
        expect.objectContaining({ imapUser: baseDto.imapUser, imapPassword: baseDto.imapPassword }),
      );
      expect(prismaMock.emailAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            folderName: 'compras_ltsoft_us',
            imapPassEnc: 'enc(app-password-secreto)',
          }),
        }),
      );
      expect(storage.ensureAccountFolder).toHaveBeenCalledWith(
        TENANT_CTX.tenantSlug,
        'compras_ltsoft_us',
      );
      expect(scheduler.syncRepeatableFor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'acc-1' }),
      );
      expect(result).not.toHaveProperty('imapPassEnc');
    });

    it('calcula folderName: compras@ltsoft.us -> compras_ltsoft_us', async () => {
      prismaMock.emailAccount.create.mockResolvedValue({ id: 'acc-1' });

      await service.create(baseDto, TENANT_CTX);

      const callArg = prismaMock.emailAccount.create.mock.calls[0][0];
      expect(callArg.data.folderName).toBe('compras_ltsoft_us');
    });

    it('pasa syncFromDate al create cuando el DTO lo incluye', async () => {
      prismaMock.emailAccount.create.mockResolvedValue({ id: 'acc-1' });

      await service.create({ ...baseDto, syncFromDate: '2026-01-15T00:00:00Z' }, TENANT_CTX);

      const callArg = prismaMock.emailAccount.create.mock.calls[0][0];
      expect(callArg.data.syncFromDate).toEqual(new Date('2026-01-15T00:00:00Z'));
    });

    it('no incluye syncFromDate en el create si el DTO lo omite (Prisma aplica el default now())', async () => {
      prismaMock.emailAccount.create.mockResolvedValue({ id: 'acc-1' });

      await service.create(baseDto, TENANT_CTX);

      const callArg = prismaMock.emailAccount.create.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('syncFromDate');
    });

    it('calcula folderName normalizado solo con [a-z0-9_-] para correos con acentos', async () => {
      prismaMock.emailAccount.create.mockResolvedValue({ id: 'acc-1' });

      await service.create({ ...baseDto, email: 'facturación.dte@empresa.com.sv' }, TENANT_CTX);

      const callArg = prismaMock.emailAccount.create.mock.calls[0][0];
      expect(callArg.data.folderName).toMatch(/^[a-z0-9_-]+$/);
    });

    it('retorna 422 QUOTA_EXCEEDED y no persiste nada si se alcanzó maxAccounts', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue({ maxAccounts: 2 });
      prismaMock.emailAccount.count.mockResolvedValue(2);

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toMatchObject({
        status: 422,
        response: { error: 'QUOTA_EXCEEDED' },
      });
      expect(imap.verifyConnection).not.toHaveBeenCalled();
      expect(prismaMock.emailAccount.create).not.toHaveBeenCalled();
    });

    it('retorna 422 IMAP_AUTH_FAILED y no persiste nada si la autenticación falla', async () => {
      imap.verifyConnection.mockRejectedValue(
        new ImapConnectionError('IMAP_AUTH_FAILED', 'Autenticación rechazada por el servidor IMAP'),
      );

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toMatchObject({
        status: 422,
        response: { error: 'IMAP_AUTH_FAILED' },
      });
      expect(prismaMock.emailAccount.create).not.toHaveBeenCalled();
      expect(storage.ensureAccountFolder).not.toHaveBeenCalled();
    });

    it('retorna 422 IMAP_HOST_UNREACHABLE cuando el host no responde', async () => {
      imap.verifyConnection.mockRejectedValue(
        new ImapConnectionError('IMAP_HOST_UNREACHABLE', 'No se pudo alcanzar el servidor IMAP'),
      );

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toMatchObject({
        status: 422,
        response: { error: 'IMAP_HOST_UNREACHABLE' },
      });
      expect(prismaMock.emailAccount.create).not.toHaveBeenCalled();
    });

    it('lanza ConflictException (pre-check) si ya existe una cuenta activa con ese email', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ email: baseDto.email });

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toMatchObject({
        status: 409,
        response: { error: 'ACCOUNT_EMAIL_EXISTS' },
      });
      expect(prismaMock.emailAccount.create).not.toHaveBeenCalled();
      expect(storage.ensureAccountFolder).not.toHaveBeenCalled();
    });

    it('lanza ConflictException (pre-check) si otro email ya normaliza al mismo folderName', async () => {
      // "compras" con acento normaliza igual que el email ya registrado.
      prismaMock.emailAccount.findFirst.mockResolvedValue({ email: 'otra@ltsoft.us' });

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toMatchObject({
        status: 409,
        response: { error: 'ACCOUNT_FOLDER_EXISTS' },
      });
      expect(prismaMock.emailAccount.create).not.toHaveBeenCalled();
    });

    it('lanza ConflictException como red de seguridad si el constraint de DB salta con meta.target null', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);
      prismaMock.emailAccount.create.mockRejectedValue(uniqueViolationWithNullTarget());

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toBeInstanceOf(ConflictException);
      expect(storage.ensureAccountFolder).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si el email ya está registrado (P2002 con target)', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);
      prismaMock.emailAccount.create.mockRejectedValue(uniqueEmailViolation());

      await expect(service.create(baseDto, TENANT_CTX)).rejects.toBeInstanceOf(ConflictException);
      expect(storage.ensureAccountFolder).not.toHaveBeenCalled();
    });
  });

  describe('findAll / findOne', () => {
    it('ninguna respuesta serializada contiene imapPassEnc', async () => {
      prismaMock.emailAccount.findMany.mockResolvedValue([{ id: 'acc-1', email: baseDto.email }]);

      const [account] = await service.findAll(TENANT_CTX);

      expect(JSON.stringify(account)).not.toContain('imapPassEnc');
      const selectArg = prismaMock.emailAccount.findMany.mock.calls[0][0].select;
      expect(selectArg.imapPassEnc).toBeUndefined();
    });

    it('filtra cuentas por tenantId y deletedAt: null en el listado', async () => {
      prismaMock.emailAccount.findMany.mockResolvedValue([]);

      await service.findAll(TENANT_CTX);

      expect(prismaMock.emailAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID, deletedAt: null } }),
      );
    });

    it('el detalle incluye las últimas 5 sincronizaciones', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      prismaMock.syncLog.findMany.mockResolvedValue([{ id: 'log-1' }]);

      const result = await service.findOne(TENANT_CTX, 'acc-1');

      expect(prismaMock.syncLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID, accountId: 'acc-1' }, take: 5 }),
      );
      expect(result.syncLogs).toEqual([{ id: 'log-1' }]);
    });

    it('lanza NotFoundException si la cuenta no existe, está borrada o es de otro tenant', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);

      await expect(service.findOne(TENANT_CTX, 'acc-inexistente')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const existingAccount = {
      id: 'acc-1',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
      imapUser: 'compras@ltsoft.us',
      imapPassEnc: 'enc(clave-vieja)',
      status: 'ACTIVA',
    };

    it('no revalida IMAP si no cambian credenciales', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(existingAccount);
      prismaMock.emailAccount.update.mockResolvedValue({ id: 'acc-1' });

      await service.update(TENANT_CTX, 'acc-1', { alias: 'Nuevo alias' });

      expect(imap.verifyConnection).not.toHaveBeenCalled();
    });

    it('revalida IMAP con la contraseña descifrada si solo cambia el host', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(existingAccount);
      prismaMock.emailAccount.update.mockResolvedValue({ id: 'acc-1' });

      await service.update(TENANT_CTX, 'acc-1', { imapHost: 'imap.otroproveedor.com' });

      expect(imap.verifyConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          imapHost: 'imap.otroproveedor.com',
          imapPassword: 'clave-vieja',
        }),
      );
    });

    it('transiciona ERROR_AUTH -> ACTIVA y resetea el contador de fallos cuando la revalidación pasa', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        ...existingAccount,
        status: 'ERROR_AUTH',
      });
      prismaMock.emailAccount.update.mockResolvedValue({ id: 'acc-1', status: 'ACTIVA' });

      await service.update(TENANT_CTX, 'acc-1', { imapPassword: 'clave-nueva' });

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVA' }) }),
      );
      expect(scheduler.resetAuthFailures).toHaveBeenCalledWith('acc-1');
      expect(scheduler.syncRepeatableFor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'acc-1', status: 'ACTIVA' }),
      );
    });

    it('no toca el contador de fallos cuando la cuenta ya estaba ACTIVA', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(existingAccount);
      prismaMock.emailAccount.update.mockResolvedValue({ id: 'acc-1', status: 'ACTIVA' });

      await service.update(TENANT_CTX, 'acc-1', { alias: 'Nuevo alias' });

      expect(scheduler.resetAuthFailures).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si el nuevo email ya lo usa otra cuenta del tenant', async () => {
      prismaMock.emailAccount.findFirst
        .mockResolvedValueOnce({ ...existingAccount, email: 'compras@ltsoft.us' })
        .mockResolvedValueOnce({ id: 'acc-2' });

      await expect(
        service.update(TENANT_CTX, 'acc-1', { email: 'ventas@ltsoft.us' }),
      ).rejects.toMatchObject({ status: 409, response: { error: 'ACCOUNT_EMAIL_EXISTS' } });
      expect(prismaMock.emailAccount.update).not.toHaveBeenCalled();
    });

    it('no persiste credenciales nuevas si la revalidación falla', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(existingAccount);
      imap.verifyConnection.mockRejectedValue(
        new ImapConnectionError('IMAP_AUTH_FAILED', 'Autenticación rechazada por el servidor IMAP'),
      );

      await expect(
        service.update(TENANT_CTX, 'acc-1', { imapPassword: 'clave-mala' }),
      ).rejects.toMatchObject({
        status: 422,
      });
      expect(prismaMock.emailAccount.update).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si la cuenta no existe o es de otro tenant', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);

      await expect(service.update(TENANT_CTX, 'acc-x', { alias: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('hace soft delete: setea deletedAt e INACTIVA en vez de borrar', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      prismaMock.emailAccount.update.mockResolvedValue({});

      await service.remove(TENANT_CTX, 'acc-1');

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { deletedAt: expect.any(Date), status: 'INACTIVA' },
      });
      expect(scheduler.removeRepeatable).toHaveBeenCalledWith('acc-1');
    });

    it('lanza NotFoundException si la cuenta ya no existe o es de otro tenant', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);

      await expect(service.remove(TENANT_CTX, 'acc-x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('triggerManualSync', () => {
    it('encola el job manual con el tenantId cuando la cuenta está ACTIVA', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1', status: 'ACTIVA' });

      const result = await service.triggerManualSync(TENANT_CTX, 'acc-1');

      expect(scheduler.enqueueManual).toHaveBeenCalledWith(TENANT_ID, 'acc-1');
      expect(result).toEqual({ enqueued: true });
    });

    it('retorna 422 si la cuenta está INACTIVA', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1', status: 'INACTIVA' });

      await expect(service.triggerManualSync(TENANT_CTX, 'acc-1')).rejects.toMatchObject({
        status: 422,
      });
      expect(scheduler.enqueueManual).not.toHaveBeenCalled();
    });

    it('retorna 422 si la cuenta está en ERROR_AUTH', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1', status: 'ERROR_AUTH' });

      await expect(service.triggerManualSync(TENANT_CTX, 'acc-1')).rejects.toMatchObject({
        status: 422,
      });
      expect(scheduler.enqueueManual).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si la cuenta no existe o es de otro tenant', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);

      await expect(service.triggerManualSync(TENANT_CTX, 'acc-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resyncFrom', () => {
    it('actualiza syncFromDate, resetea lastSyncAt a null y encola el sync', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1', status: 'ACTIVA' });
      prismaMock.emailAccount.update.mockResolvedValue({ id: 'acc-1' });

      const result = await service.resyncFrom(TENANT_CTX, 'acc-1', {
        syncFromDate: '2026-01-01T00:00:00Z',
      });

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'acc-1' },
          data: { syncFromDate: new Date('2026-01-01T00:00:00Z'), lastSyncAt: null },
        }),
      );
      expect(scheduler.enqueueManual).toHaveBeenCalledWith(TENANT_ID, 'acc-1');
      expect(result).toEqual({ enqueued: true });
    });

    it('retorna 422 si la cuenta no está ACTIVA y no toca nada', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({ id: 'acc-1', status: 'ERROR_AUTH' });

      await expect(
        service.resyncFrom(TENANT_CTX, 'acc-1', { syncFromDate: '2026-01-01T00:00:00Z' }),
      ).rejects.toMatchObject({ status: 422 });
      expect(prismaMock.emailAccount.update).not.toHaveBeenCalled();
      expect(scheduler.enqueueManual).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si la cuenta no existe o es de otro tenant', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(null);

      await expect(
        service.resyncFrom(TENANT_CTX, 'acc-x', { syncFromDate: '2026-01-01T00:00:00Z' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('testConnection', () => {
    it('retorna { ok: true, latencyMs } cuando la conexión es válida', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        id: 'acc-1',
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'compras@ltsoft.us',
        imapPassEnc: 'enc(clave)',
      });
      imap.verifyConnection.mockResolvedValue({ latencyMs: 123 });

      const result = await service.testConnection(TENANT_CTX, 'acc-1');

      expect(result).toEqual({ ok: true, latencyMs: 123 });
    });

    it('retorna un error diferenciado si la conexión falla', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        id: 'acc-1',
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'compras@ltsoft.us',
        imapPassEnc: 'enc(clave)',
      });
      imap.verifyConnection.mockRejectedValue(
        new ImapConnectionError('IMAP_TLS_ERROR', 'Error de TLS al conectar con el servidor IMAP'),
      );

      await expect(service.testConnection(TENANT_CTX, 'acc-1')).rejects.toMatchObject({
        status: 422,
        response: { error: 'IMAP_TLS_ERROR' },
      });
    });
  });
});
