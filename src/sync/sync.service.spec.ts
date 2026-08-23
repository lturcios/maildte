import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { SyncService } from './sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AesService } from '../common/crypto/aes.service';
import { AppConfigService } from '../config/app-config.service';
import { StorageService } from '../storage/storage.service';
import { ImapClientFactory } from './imap/imap-client.factory';
import { SyncScheduler } from './sync.scheduler';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { fakeRawEmail, imapFlowMock } from './imap/imap-test-utils';

const DATE = 'Tue, 08 Sep 2026 15:00:00 -0600';
const TENANT_ID = 'tenant-1';
const TENANT_SLUG = 'tenant-1-slug';

const account = {
  id: 'acc-1',
  tenantId: TENANT_ID,
  alias: 'Cuenta de prueba',
  email: 'compras@ltsoft.us',
  folderName: 'compras_ltsoft_us',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  imapUser: 'compras@ltsoft.us',
  imapPassEnc: 'enc(clave)',
  mailbox: 'INBOX',
  syncInterval: 300,
  syncFromDate: new Date('2026-01-01T00:00:00Z'),
  lastUid: 5,
  uidValidity: 100n,
  lastSyncAt: new Date('2026-08-01T00:00:00Z'),
  lastError: null,
  status: 'ACTIVA' as const,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  processedEmail: { findUnique: jest.fn(), create: jest.fn() },
  emailAccount: { update: jest.fn(), findFirst: jest.fn() },
  syncLog: { create: jest.fn(), update: jest.fn() },
  tenant: { findUnique: jest.fn() },
  attachment: { aggregate: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

function uniqueMessageIdViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: ['accountId_messageId'] },
  });
}

describe('SyncService', () => {
  let service: SyncService;
  let aes: { encrypt: jest.Mock; decrypt: jest.Mock };
  let imap: { create: jest.Mock };
  let storage: {
    resolveMonthFolder: jest.Mock;
    saveAttachment: jest.Mock;
    deleteFiles: jest.Mock;
    cleanOrphanTmp: jest.Mock;
  };
  let config: { maxAttachmentMb: number };
  let scheduler: { removeRepeatable: jest.Mock };
  let redis: {
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    incrby: jest.Mock;
    decrby: jest.Mock;
  };

  async function syncAccount(): Promise<void> {
    return service.syncAccount(TENANT_ID, 'acc-1', 'scheduler');
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    prismaMock.emailAccount.update.mockResolvedValue({});
    prismaMock.emailAccount.findFirst.mockResolvedValue(account);
    prismaMock.syncLog.update.mockResolvedValue({});
    prismaMock.syncLog.create.mockResolvedValue({ id: 'log-1' });
    prismaMock.processedEmail.findUnique.mockResolvedValue(null);
    prismaMock.processedEmail.create.mockResolvedValue({ id: 'email-1' });
    prismaMock.tenant.findUnique.mockResolvedValue({
      status: 'ACTIVO',
      slug: TENANT_SLUG,
      maxStorageBytes: 5_000_000_000n,
    });
    prismaMock.attachment.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });

    aes = { encrypt: jest.fn(), decrypt: jest.fn().mockReturnValue('plain-password') };
    imap = { create: jest.fn() };
    storage = {
      resolveMonthFolder: jest.fn().mockReturnValue('2026-09'),
      saveAttachment: jest
        .fn()
        .mockImplementation(async (_tenantSlug: string, { originalName }) => ({
          storedName: originalName,
          relativePath: `${TENANT_SLUG}/compras_ltsoft_us/2026-09/json/${originalName}`,
          sizeBytes: 10,
          sha256: `hash-${originalName}`,
          reused: false,
        })),
      deleteFiles: jest.fn().mockResolvedValue(undefined),
      cleanOrphanTmp: jest.fn().mockResolvedValue(undefined),
    };
    config = { maxAttachmentMb: 25 };
    scheduler = { removeRepeatable: jest.fn().mockResolvedValue(undefined) };

    const usageStore = new Map<string, number>();
    const lockStore = new Map<string, string>();
    redis = {
      set: jest.fn(async (key: string, value: string) => {
        if (key.startsWith('lock:')) lockStore.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => {
        if (key.startsWith('lock:')) return lockStore.get(key) ?? null;
        if (key.startsWith('usage:bytes:')) return usageStore.get(key)?.toString() ?? null;
        return null;
      }),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      incrby: jest.fn(async (key: string, delta: number) => {
        const next = (usageStore.get(key) ?? 0) + delta;
        usageStore.set(key, next);
        return next;
      }),
      decrby: jest.fn(async (key: string, delta: number) => {
        const next = (usageStore.get(key) ?? 0) - delta;
        usageStore.set(key, next);
        return next;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AesService, useValue: aes },
        { provide: ImapClientFactory, useValue: imap },
        { provide: StorageService, useValue: storage },
        { provide: AppConfigService, useValue: config },
        { provide: SyncScheduler, useValue: scheduler },
        { provide: REDIS_CONNECTION, useValue: redis },
        {
          provide: PinoLogger,
          useValue: {
            setContext: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(SyncService);
  });

  describe('revalidación del job (payload tenantId/accountId)', () => {
    it('si la cuenta no pertenece al tenant del payload, termina sin error y sin tocar IMAP', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValueOnce(null); // revalidateJob no la encuentra

      await syncAccount();

      expect(imap.create).not.toHaveBeenCalled();
      expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
    });

    it('si el tenant no está ACTIVO, termina sin error y sin tocar IMAP', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue({
        status: 'SUSPENDIDO',
        slug: TENANT_SLUG,
        maxStorageBytes: 5_000_000_000n,
      });

      await syncAccount();

      expect(imap.create).not.toHaveBeenCalled();
      expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
    });
  });

  describe('lock distribuido', () => {
    it('si el lock está ocupado, termina sin error y sin tocar IMAP', async () => {
      redis.set.mockResolvedValueOnce(null);

      await syncAccount();

      expect(imap.create).not.toHaveBeenCalled();
      expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
    });

    it('libera el lock al finalizar un sync exitoso', async () => {
      imap.create.mockReturnValue(imapFlowMock([]));

      await syncAccount();

      expect(redis.del).toHaveBeenCalledWith('lock:sync:acc-1');
    });
  });

  describe('guard de UID', () => {
    it('un mensaje con uid <= lastUid retornado por el rango "n:*" se omite', async () => {
      const client = imapFlowMock([
        {
          uid: 5,
          source: fakeRawEmail({ messageId: 'msg-5-ya-visto', from: 'a@b.com', date: DATE }),
        },
        { uid: 6, source: fakeRawEmail({ messageId: 'msg-6', from: 'a@b.com', date: DATE }) },
      ]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(prismaMock.processedEmail.findUnique).toHaveBeenCalledTimes(1);
      expect(prismaMock.processedEmail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId_messageId: { accountId: 'acc-1', messageId: '<msg-6>' } },
        }),
      );
    });

    it('usa el rango lastUid+1:* al invocar fetch', async () => {
      const client = imapFlowMock([]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(client.fetch).toHaveBeenCalledWith(
        '6:*',
        { uid: true, envelope: true, source: true },
        { uid: true },
      );
      expect(client.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
    });
  });

  describe('idempotencia', () => {
    it('correo con messageId ya registrado -> skip, emailsSkipped incrementa, no se escribe archivo', async () => {
      prismaMock.processedEmail.findUnique.mockResolvedValue({ id: 'ya-existe' });
      const raw = fakeRawEmail({
        messageId: 'msg-dup',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'factura.json', contentType: 'application/json', body: '{}' }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).not.toHaveBeenCalled();
      const finalLog = prismaMock.syncLog.update.mock.calls.at(-1)?.[0];
      expect(finalLog.data).toEqual(
        expect.objectContaining({ emailsSkipped: 1, emailsProcessed: 0, status: 'COMPLETADO' }),
      );
    });

    it('un correo saltado por duplicado igual avanza lastUid (un lote que termina en duplicados no queda estancado)', async () => {
      prismaMock.processedEmail.findUnique.mockResolvedValue({ id: 'ya-existe' });
      const raw = fakeRawEmail({ messageId: 'msg-dup', from: 'a@b.com', date: DATE });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { lastUid: 6 },
      });
    });

    it('violación P2002 en la transacción (carrera) se trata como duplicado, no como ERROR', async () => {
      prismaMock.processedEmail.create.mockImplementationOnce(async () => {
        throw uniqueMessageIdViolation();
      });
      const raw = fakeRawEmail({
        messageId: 'msg-race',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'factura.json', contentType: 'application/json', body: '{}' }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.deleteFiles).toHaveBeenCalledWith(TENANT_SLUG, [
        `${TENANT_SLUG}/compras_ltsoft_us/2026-09/json/factura.json`,
      ]);
      const finalLog = prismaMock.syncLog.update.mock.calls.at(-1)?.[0];
      expect(finalLog.data).toEqual(
        expect.objectContaining({ emailsSkipped: 1, status: 'COMPLETADO' }),
      );
      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { lastUid: 6 },
      });
    });
  });

  describe('fallo al persistir un correo (no P2002)', () => {
    it('hace deleteFiles de lo escrito, el correo queda ERROR y el lote continúa con el siguiente', async () => {
      prismaMock.processedEmail.create.mockImplementation(
        async (args: { data: { uid: number; status: string } }) => {
          if (args.data.uid === 6 && args.data.status === 'PROCESADO') {
            throw new Error('disco lleno');
          }
          return { id: 'created' };
        },
      );
      const attachment = { filename: 'factura.json', contentType: 'application/json', body: '{}' };
      const client = imapFlowMock([
        {
          uid: 6,
          source: fakeRawEmail({
            messageId: 'msg-6',
            from: 'a@b.com',
            date: DATE,
            attachments: [attachment],
          }),
        },
        {
          uid: 7,
          source: fakeRawEmail({
            messageId: 'msg-7',
            from: 'a@b.com',
            date: DATE,
            attachments: [attachment],
          }),
        },
      ]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(storage.deleteFiles).toHaveBeenCalledWith(TENANT_SLUG, [
        `${TENANT_SLUG}/compras_ltsoft_us/2026-09/json/factura.json`,
      ]);
      // el correo 7 sí se procesó (el lote continuó tras el fallo del correo 6)
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ uid: 7, status: 'PROCESADO' }) }),
      );
      // el correo 6 quedó registrado como ERROR
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ uid: 6, status: 'ERROR' }) }),
      );
      const finalLog = prismaMock.syncLog.update.mock.calls.at(-1)?.[0];
      expect(finalLog.data.status).toBe('COMPLETADO_CON_ERRORES');
      expect(finalLog.data.emailsProcessed).toBe(2);
    });
  });

  describe('filtrado de adjuntos', () => {
    it('correo sin adjuntos json/pdf válidos -> SIN_ADJUNTOS, sin archivos (imagen.png se ignora)', async () => {
      const raw = fakeRawEmail({
        messageId: 'msg-sin-adjuntos',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'imagen.png', contentType: 'image/png', body: 'binario' }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).not.toHaveBeenCalled();
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SIN_ADJUNTOS', attachmentCount: 0 }),
        }),
      );
    });

    it('adjunto con mimeType genérico pero nombre .json SÍ se descarga (criterio OR)', async () => {
      const raw = fakeRawEmail({
        messageId: 'msg-or-nombre',
        from: 'a@b.com',
        date: DATE,
        attachments: [
          {
            filename: 'factura.json',
            contentType: 'application/octet-stream',
            body: '{"ok":true}',
          },
        ],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).toHaveBeenCalledWith(
        TENANT_SLUG,
        expect.objectContaining({ originalName: 'factura.json' }),
      );
    });

    it('adjunto application/pdf con nombre sin extensión reconocible SÍ se descarga (criterio OR)', async () => {
      const raw = fakeRawEmail({
        messageId: 'msg-or-mime',
        from: 'a@b.com',
        date: DATE,
        attachments: [
          { filename: 'documento.bin', contentType: 'application/pdf', body: '%PDF fake' },
        ],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).toHaveBeenCalledWith(
        TENANT_SLUG,
        expect.objectContaining({ originalName: 'documento.bin', mimeType: 'application/pdf' }),
      );
    });
  });

  describe('límite MAX_ATTACHMENT_MB', () => {
    it('un adjunto que excede el límite se omite con nota en errorDetail del correo', async () => {
      config.maxAttachmentMb = 1;
      const bigBody = 'x'.repeat(2 * 1024 * 1024);
      const raw = fakeRawEmail({
        messageId: 'msg-grande',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'grande.pdf', contentType: 'application/pdf', body: bigBody }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).not.toHaveBeenCalled();
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SIN_ADJUNTOS',
            errorDetail: expect.stringContaining('grande.pdf'),
          }),
        }),
      );
    });
  });

  describe('cuota de almacenamiento del tenant', () => {
    it('adjuntos que excederían maxStorageBytes -> correo ERROR QUOTA_EXCEEDED sin descargar, el sync continúa', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue({
        status: 'ACTIVO',
        slug: TENANT_SLUG,
        maxStorageBytes: 0n, // cualquier adjunto con tamaño > 0 supera este límite
      });
      const raw = fakeRawEmail({
        messageId: 'msg-cuota',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'factura.json', contentType: 'application/json', body: '{}' }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).not.toHaveBeenCalled();
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ERROR',
            errorDetail: expect.stringContaining('QUOTA_EXCEEDED'),
          }),
        }),
      );
      const finalLog = prismaMock.syncLog.update.mock.calls.at(-1)?.[0];
      expect(finalLog.data.status).toBe('COMPLETADO_CON_ERRORES');
    });

    it('con cuota disponible, el adjunto se guarda y el contador de uso se incrementa', async () => {
      const raw = fakeRawEmail({
        messageId: 'msg-con-cuota',
        from: 'a@b.com',
        date: DATE,
        attachments: [{ filename: 'factura.json', contentType: 'application/json', body: '{}' }],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).toHaveBeenCalled();
      expect(redis.incrby).toHaveBeenCalledWith(`usage:bytes:${TENANT_ID}`, 10);
    });
  });

  describe('UIDVALIDITY', () => {
    it('uidValidity distinto al persistido -> lastUid reseteado a 0 antes del fetch', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        ...account,
        lastUid: 50,
        uidValidity: 100n,
      });
      const client = imapFlowMock([], 200n);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { uidValidity: 200n, lastUid: 0 },
      });
      expect(client.fetch).toHaveBeenCalledWith('1:*', expect.anything(), expect.anything());
    });

    it('primera vez (uidValidity null) no loguea warning de reset, solo registra el valor', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        ...account,
        lastUid: 0,
        uidValidity: null,
      });
      const client = imapFlowMock([], 555n);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { uidValidity: 555n, lastUid: 0 },
      });
    });
  });

  describe('primera sincronización (RF-02.2)', () => {
    const neverSyncedAccount = {
      ...account,
      lastUid: 0,
      uidValidity: null,
      lastSyncAt: null,
      syncFromDate: new Date('2026-08-01T00:00:00Z'),
    };

    it('busca por SINCE=syncFromDate y arranca el fetch un UID antes del primer match', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(neverSyncedAccount);
      const client = imapFlowMock([], 100n, 500);
      client.search.mockResolvedValue([120, 118, 130]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(client.search).toHaveBeenCalledWith(
        { since: new Date(neverSyncedAccount.syncFromDate.getTime() - 24 * 60 * 60 * 1000) },
        { uid: true },
      );
      expect(client.fetch).toHaveBeenCalledWith('118:*', expect.anything(), expect.anything());
    });

    it('si no hay nada desde syncFromDate, el fetch no trae nada del histórico', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(neverSyncedAccount);
      const client = imapFlowMock([], 100n, 800);
      client.search.mockResolvedValue([]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(client.fetch).toHaveBeenCalledWith('800:*', expect.anything(), expect.anything());
    });

    it('persiste el lastUid resuelto aunque no llegue ningún correo (para no repetir la búsqueda desde UID 1)', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue(neverSyncedAccount);
      const client = imapFlowMock([], 100n, 800);
      client.search.mockResolvedValue([]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { lastUid: 799 },
      });
    });

    it('una cuenta que ya sincronizó antes NO vuelve a buscar por syncFromDate ante un reset de UIDVALIDITY', async () => {
      prismaMock.emailAccount.findFirst.mockResolvedValue({
        ...account,
        lastUid: 50,
        uidValidity: 100n,
        lastSyncAt: new Date('2026-08-01T00:00:00Z'),
      });
      const client = imapFlowMock([], 999n);
      imap.create.mockReturnValue(client);

      await syncAccount();

      expect(client.search).not.toHaveBeenCalled();
      expect(client.fetch).toHaveBeenCalledWith('1:*', expect.anything(), expect.anything());
    });
  });

  describe('lastUid incremental', () => {
    it('se actualiza tras cada correo, no al final del lote', async () => {
      const attachment = { filename: 'factura.json', contentType: 'application/json', body: '{}' };
      const client = imapFlowMock([
        {
          uid: 6,
          source: fakeRawEmail({
            messageId: 'm6',
            from: 'a@b.com',
            date: DATE,
            attachments: [attachment],
          }),
        },
        {
          uid: 7,
          source: fakeRawEmail({
            messageId: 'm7',
            from: 'a@b.com',
            date: DATE,
            attachments: [attachment],
          }),
        },
      ]);
      imap.create.mockReturnValue(client);

      await syncAccount();

      const lastUidUpdates = prismaMock.emailAccount.update.mock.calls
        .filter((call: [{ data?: { lastUid?: number } }]) => call[0]?.data?.lastUid !== undefined)
        .map((call: [{ data: { lastUid: number } }]) => call[0].data.lastUid);
      expect(lastUidUpdates).toEqual([6, 7]);
    });
  });

  describe('flujo feliz completo', () => {
    it('procesa un correo con JSON y PDF: crea ProcessedEmail + 2 Attachment y SyncLog COMPLETADO', async () => {
      const raw = fakeRawEmail({
        messageId: 'msg-full',
        from: 'proveedor@dte.com',
        date: DATE,
        attachments: [
          { filename: 'factura.json', contentType: 'application/json', body: '{"total":100}' },
          { filename: 'factura.pdf', contentType: 'application/pdf', body: '%PDF fake' },
        ],
      });
      imap.create.mockReturnValue(imapFlowMock([{ uid: 6, source: raw }]));

      await syncAccount();

      expect(storage.saveAttachment).toHaveBeenCalledTimes(2);
      expect(prismaMock.processedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PROCESADO',
            attachmentCount: 2,
            attachments: {
              create: expect.arrayContaining([
                expect.objectContaining({ fileType: 'JSON' }),
                expect.objectContaining({ fileType: 'PDF' }),
              ]),
            },
          }),
        }),
      );
      const finalLog = prismaMock.syncLog.update.mock.calls.at(-1)?.[0];
      expect(finalLog.data.status).toBe('COMPLETADO');
      expect(finalLog.data.filesDownloaded).toBe(2);
    });
  });

  describe('clasificación de errores de conexión', () => {
    it('fallo de conexión IMAP: SyncLog queda en ERROR y el error se relanza para que BullMQ reintente', async () => {
      const client = imapFlowMock([]);
      client.connect.mockRejectedValue(
        Object.assign(new Error('bad creds'), { authenticationFailed: true }),
      );
      imap.create.mockReturnValue(client);

      await expect(syncAccount()).rejects.toMatchObject({
        code: 'IMAP_AUTH_FAILED',
      });

      expect(prismaMock.syncLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR' }) }),
      );
    });

    it('un sync exitoso resetea el contador de fallos de autenticación', async () => {
      imap.create.mockReturnValue(imapFlowMock([]));

      await syncAccount();

      expect(redis.del).toHaveBeenCalledWith('auth-fail:acc-1');
    });

    it('tras 3 fallos de autenticación consecutivos, la cuenta pasa a ERROR_AUTH y se remueve el job repetible', async () => {
      redis.incr.mockResolvedValue(3);
      const client = imapFlowMock([]);
      client.connect.mockRejectedValue(
        Object.assign(new Error('bad creds'), { authenticationFailed: true }),
      );
      imap.create.mockReturnValue(client);

      await expect(syncAccount()).rejects.toBeDefined();

      expect(prismaMock.emailAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR_AUTH' }) }),
      );
      expect(scheduler.removeRepeatable).toHaveBeenCalledWith('acc-1');
    });

    it('un fallo de host inalcanzable NO incrementa el contador de auth-fail', async () => {
      const client = imapFlowMock([]);
      client.connect.mockRejectedValue(
        Object.assign(new Error('no route'), { code: 'ECONNREFUSED' }),
      );
      imap.create.mockReturnValue(client);

      await expect(syncAccount()).rejects.toMatchObject({
        code: 'IMAP_HOST_UNREACHABLE',
      });

      expect(redis.incr).not.toHaveBeenCalled();
    });
  });
});
