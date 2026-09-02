import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { MailProvidersService } from './mail-providers.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { TenantContext } from '../common/tenancy/tenant-context';
import { lookupMxExchanges } from './mx-lookup';

// Solo se mockea la consulta DNS (I/O externo). matchesMxSuffix y domainOfEmail
// quedan reales: son la lógica que hay que verificar, no una dependencia.
jest.mock('./mx-lookup', () => ({
  ...jest.requireActual<typeof import('./mx-lookup')>('./mx-lookup'),
  lookupMxExchanges: jest.fn(),
}));

const lookupMxExchangesMock = lookupMxExchanges as jest.MockedFunction<typeof lookupMxExchanges>;

const SUPERADMIN_CTX: TenantContext = {
  tenantId: null,
  tenantSlug: null,
  actor: { type: 'user', id: 'user-super', role: 'SUPERADMIN' },
};

const PROVIDER_ID = '3f1b0a2e-6c4d-4f8a-9b1e-0d2c5a7e9f31';

// Declaraciones de función (hoisted) para no auto-referenciar prismaMock en su
// propio inicializador: TS no puede inferir el tipo si se cierra sobre sí mismo.
function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

function callTransactionMock(fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  mailProvider: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  mailProviderDomain: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  tenant: {
    findMany: jest.fn(),
  },
  emailAccount: {
    groupBy: jest.fn(),
  },
  withTenant: jest.fn(callWithTenantMock),
  $transaction: jest.fn(callTransactionMock),
};

const existingProvider = {
  id: PROVIDER_ID,
  key: 'gmail',
  name: 'Gmail / Google Workspace',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  defaultMailbox: 'INBOX',
  strict: true,
  notes: null,
  helpUrl: null,
  active: true,
  sortOrder: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  domains: [],
};

/**
 * Configura el conteo cross-tenant de PROVIDER_ID: recibe, por tenant,
 * [total, activas]. Por cada tenant, usageAll() hace dos groupBy (todas y solo
 * las vivas) dentro de withTenant.
 */
function mockUsage(perTenant: [number, number][]): void {
  prismaMock.tenant.findMany.mockResolvedValue(
    perTenant.map((_, index) => ({ id: `tenant-${index + 1}` })),
  );
  prismaMock.emailAccount.groupBy.mockReset();
  for (const [total, active] of perTenant) {
    prismaMock.emailAccount.groupBy
      .mockResolvedValueOnce(
        total > 0 ? [{ providerId: PROVIDER_ID, _count: { _all: total } }] : [],
      )
      .mockResolvedValueOnce(
        active > 0 ? [{ providerId: PROVIDER_ID, _count: { _all: active } }] : [],
      );
  }
}

const redisMock = {
  get: jest.fn(),
  set: jest.fn(),
};

describe('MailProvidersService', () => {
  let service: MailProvidersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.$transaction.mockImplementation(callTransactionMock);
    prismaMock.mailProvider.findUnique.mockResolvedValue(existingProvider);
    prismaMock.mailProviderDomain.findFirst.mockResolvedValue(null);
    prismaMock.mailProviderDomain.findMany.mockResolvedValue([]);
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    lookupMxExchangesMock.mockResolvedValue([]);

    const logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MailProvidersService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: REDIS_CONNECTION, useValue: redisMock },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(MailProvidersService);
  });

  // Addendum 09, ADR-09.3 — detección del proveedor.
  describe('resolveByEmail', () => {
    const workspaceSuffix = { domain: 'google.com', provider: existingProvider };

    it('detecta por dominio exacto sin tocar el DNS', async () => {
      prismaMock.mailProviderDomain.findFirst.mockResolvedValue({ provider: existingProvider });

      const result = await service.resolveByEmail('alguien@gmail.com');

      expect(result.source).toBe('DOMAIN');
      expect(result.provider).toEqual(existingProvider);
      expect(lookupMxExchangesMock).not.toHaveBeenCalled();
    });

    it('detecta por MX cuando el dominio es propio (Workspace detrás de empresa.com.sv)', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue(['aspmx.l.google.com', 'alt1.aspmx.l.google.com']);

      const result = await service.resolveByEmail('facturacion@empresa.com.sv');

      expect(result.source).toBe('MX');
      expect(result.provider).toEqual(existingProvider);
      expect(lookupMxExchangesMock).toHaveBeenCalledWith('empresa.com.sv');
    });

    it('respeta la prioridad del MX: gana el primer exchange que matchea', async () => {
      const otro = { ...existingProvider, id: 'otro', key: 'zoho' };
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([
        { domain: 'zoho.com', provider: otro },
        workspaceSuffix,
      ]);
      // lookupMxExchanges ya devuelve ordenado por prioridad.
      lookupMxExchangesMock.mockResolvedValue(['aspmx.l.google.com', 'mx.zoho.com']);

      const result = await service.resolveByEmail('info@empresa.com.sv');

      expect(result.provider?.key).toBe('gmail');
    });

    it('NO detecta nada si el MX es un gateway de filtrado', async () => {
      // pphosted/mimecast dicen por dónde ENTRA el correo, no dónde se leen los
      // buzones. Como no están en el catálogo, no hay match y el usuario elige
      // a mano — que es exactamente lo correcto.
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue(['mx1.empresa.com.pphosted.com']);

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result).toEqual({ provider: null, source: null });
    });

    it('no confunde un dominio que solo termina parecido al sufijo', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue(['mail.notgoogle.com']);

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result).toEqual({ provider: null, source: null });
    });

    it('devuelve null sin consultar DNS si la dirección no tiene forma de correo', async () => {
      const result = await service.resolveByEmail('sin-arroba');

      expect(result).toEqual({ provider: null, source: null });
      expect(lookupMxExchangesMock).not.toHaveBeenCalled();
    });

    it('devuelve null cuando el dominio no tiene MX (DNS vacío o caído)', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue([]);

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result).toEqual({ provider: null, source: null });
    });

    it('usa la caché de Redis y evita la consulta DNS', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      redisMock.get.mockResolvedValue(JSON.stringify(['aspmx.l.google.com']));

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result.source).toBe('MX');
      expect(lookupMxExchangesMock).not.toHaveBeenCalled();
    });

    it('cachea el resultado DNS, no el perfil: un sufijo nuevo aplica al instante', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue(['aspmx.l.google.com']);

      await service.resolveByEmail('alguien@empresa.com');

      expect(redisMock.set).toHaveBeenCalledWith(
        'mx:empresa.com',
        JSON.stringify(['aspmx.l.google.com']),
        'EX',
        24 * 60 * 60,
      );
    });

    it('cachea el resultado vacío con TTL corto para no negar la detección 24 h', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      lookupMxExchangesMock.mockResolvedValue([]);

      await service.resolveByEmail('alguien@recien-configurado.com');

      expect(redisMock.set).toHaveBeenCalledWith('mx:recien-configurado.com', '[]', 'EX', 60 * 60);
    });

    it('sigue funcionando si Redis está caído', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([workspaceSuffix]);
      redisMock.get.mockRejectedValue(new Error('Redis no disponible'));
      redisMock.set.mockRejectedValue(new Error('Redis no disponible'));
      lookupMxExchangesMock.mockResolvedValue(['aspmx.l.google.com']);

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result.source).toBe('MX');
    });

    it('no consulta DNS si el catálogo no tiene ningún sufijo MX cargado', async () => {
      prismaMock.mailProviderDomain.findMany.mockResolvedValue([]);

      const result = await service.resolveByEmail('alguien@empresa.com');

      expect(result).toEqual({ provider: null, source: null });
      expect(lookupMxExchangesMock).not.toHaveBeenCalled();
    });

    it('solo considera perfiles habilitados', async () => {
      await service.resolveByEmail('alguien@gmail.com');

      expect(prismaMock.mailProviderDomain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ provider: { active: true } }),
        }),
      );
      expect(prismaMock.mailProviderDomain.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ provider: { active: true } }),
        }),
      );
    });
  });

  describe('usage', () => {
    it('suma cuentas a través de todos los tenants y cuenta organizaciones distintas', async () => {
      mockUsage([
        [3, 3],
        [0, 0],
        [2, 1],
      ]);

      const usage = await service.usage(PROVIDER_ID);

      expect(usage).toEqual({
        accounts: 5,
        activeAccounts: 4,
        deletedAccounts: 1,
        tenants: 2,
      });
    });

    it('usageAll agrupa varios perfiles en una sola pasada por tenant', async () => {
      prismaMock.tenant.findMany.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
      prismaMock.emailAccount.groupBy.mockReset();
      prismaMock.emailAccount.groupBy
        // tenant-1: 3 de gmail (2 vivas), 1 de zoho (1 viva)
        .mockResolvedValueOnce([
          { providerId: 'gmail', _count: { _all: 3 } },
          { providerId: 'zoho', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { providerId: 'gmail', _count: { _all: 2 } },
          { providerId: 'zoho', _count: { _all: 1 } },
        ])
        // tenant-2: 2 de gmail (todas vivas)
        .mockResolvedValueOnce([{ providerId: 'gmail', _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ providerId: 'gmail', _count: { _all: 2 } }]);

      const all = await service.usageAll();

      expect(all.gmail).toEqual({
        accounts: 5,
        activeAccounts: 4,
        deletedAccounts: 1,
        tenants: 2,
      });
      expect(all.zoho).toEqual({
        accounts: 1,
        activeAccounts: 1,
        deletedAccounts: 0,
        tenants: 1,
      });
      // Dos consultas por organización, no dos por perfil por organización.
      expect(prismaMock.emailAccount.groupBy).toHaveBeenCalledTimes(4);
    });

    it('usage() de un perfil sin cuentas devuelve el conteo en cero', async () => {
      mockUsage([[0, 0]]);

      await expect(service.usage('perfil-sin-uso')).resolves.toEqual({
        accounts: 0,
        activeAccounts: 0,
        deletedAccounts: 0,
        tenants: 0,
      });
    });

    it('cuenta dentro de withTenant: sin tenant en contexto el RLS devolvería 0 filas', async () => {
      mockUsage([[1, 1]]);

      await service.usage(PROVIDER_ID);

      expect(prismaMock.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(prismaMock.emailAccount.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
      );
    });
  });

  describe('update', () => {
    it('exige confirmAffectedAccounts para cambiar el host de un perfil en uso', async () => {
      mockUsage([[4, 4]]);

      await expect(
        service.update(PROVIDER_ID, { imapHost: 'imap.nuevo.example' }, SUPERADMIN_CTX),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: 'PROVIDER_ENDPOINT_CONFIRM_REQUIRED' },
      });
      expect(prismaMock.mailProvider.update).not.toHaveBeenCalled();
    });

    it('rechaza la confirmación si el número no coincide con las cuentas reales', async () => {
      mockUsage([[4, 4]]);

      await expect(
        service.update(
          PROVIDER_ID,
          { imapHost: 'imap.nuevo.example', confirmAffectedAccounts: 3 },
          SUPERADMIN_CTX,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: 'PROVIDER_ENDPOINT_CONFIRM_REQUIRED' },
      });
      expect(prismaMock.mailProvider.update).not.toHaveBeenCalled();
    });

    it('aplica el cambio cuando la confirmación coincide', async () => {
      mockUsage([[4, 4]]);
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(
        PROVIDER_ID,
        { imapHost: 'imap.nuevo.example', confirmAffectedAccounts: 4 },
        SUPERADMIN_CTX,
      );

      expect(prismaMock.mailProvider.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ imapHost: 'imap.nuevo.example' }),
        }),
      );
    });

    it('no pide confirmación si el perfil no lo usa ninguna cuenta', async () => {
      mockUsage([[0, 0]]);
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(PROVIDER_ID, { imapHost: 'imap.nuevo.example' }, SUPERADMIN_CTX);

      expect(prismaMock.mailProvider.update).toHaveBeenCalled();
    });

    it('no pide confirmación para cambios que no tocan el endpoint', async () => {
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(PROVIDER_ID, { name: 'Gmail', notes: 'nota nueva' }, SUPERADMIN_CTX);

      expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
      expect(prismaMock.mailProvider.update).toHaveBeenCalled();
    });

    it('no pide confirmación si el valor enviado es igual al que ya tenía', async () => {
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(
        PROVIDER_ID,
        { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true },
        SUPERADMIN_CTX,
      );

      expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
      expect(prismaMock.mailProvider.update).toHaveBeenCalled();
    });

    it('deshabilitar el perfil (active: false) no requiere confirmación', async () => {
      prismaMock.mailProvider.update.mockResolvedValue({ ...existingProvider, active: false });

      await service.update(PROVIDER_ID, { active: false }, SUPERADMIN_CTX);

      expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
      expect(prismaMock.mailProvider.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ active: false }) }),
      );
    });

    it('con `domains` reemplaza la lista completa y normaliza a minúsculas', async () => {
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(
        PROVIDER_ID,
        { domains: [{ domain: 'GMail.COM', kind: 'DOMAIN' }] },
        SUPERADMIN_CTX,
      );

      expect(prismaMock.mailProviderDomain.deleteMany).toHaveBeenCalledWith({
        where: { providerId: PROVIDER_ID },
      });
      expect(prismaMock.mailProviderDomain.createMany).toHaveBeenCalledWith({
        data: [{ domain: 'gmail.com', kind: 'DOMAIN', providerId: PROVIDER_ID }],
      });
    });

    it('sin `domains` no toca los dominios existentes', async () => {
      prismaMock.mailProvider.update.mockResolvedValue(existingProvider);

      await service.update(PROVIDER_ID, { name: 'Otro nombre' }, SUPERADMIN_CTX);

      expect(prismaMock.mailProviderDomain.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.mailProviderDomain.createMany).not.toHaveBeenCalled();
    });

    it('lanza 404 si el perfil no existe', async () => {
      prismaMock.mailProvider.findUnique.mockResolvedValue(null);

      await expect(
        service.update(PROVIDER_ID, { name: 'x' }, SUPERADMIN_CTX),
      ).rejects.toMatchObject({ status: 404, response: { error: 'PROVIDER_NOT_FOUND' } });
    });
  });

  describe('remove', () => {
    it('borra el perfil cuando ninguna cuenta lo usa', async () => {
      mockUsage([[0, 0]]);

      await service.remove(PROVIDER_ID, SUPERADMIN_CTX);

      expect(prismaMock.mailProvider.delete).toHaveBeenCalledWith({ where: { id: PROVIDER_ID } });
    });

    it('lanza 409 PROVIDER_IN_USE si alguna cuenta lo usa', async () => {
      mockUsage([[2, 2]]);

      await expect(service.remove(PROVIDER_ID, SUPERADMIN_CTX)).rejects.toMatchObject({
        status: 409,
        response: { error: 'PROVIDER_IN_USE' },
      });
      expect(prismaMock.mailProvider.delete).not.toHaveBeenCalled();
    });

    it('las cuentas con soft delete también bloquean, y el mensaje lo explica', async () => {
      // Ninguna cuenta viva, pero 2 eliminadas conservan el providerId.
      mockUsage([[2, 0]]);

      await expect(service.remove(PROVIDER_ID, SUPERADMIN_CTX)).rejects.toMatchObject({
        status: 409,
        response: {
          error: 'PROVIDER_IN_USE',
          message: expect.stringContaining('2 de ellas eliminadas'),
        },
      });
      expect(prismaMock.mailProvider.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAllActive', () => {
    it('el catálogo del alta de cuentas excluye los perfiles deshabilitados', async () => {
      prismaMock.mailProvider.findMany.mockResolvedValue([]);

      await service.findAllActive();

      expect(prismaMock.mailProvider.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } }),
      );
    });

    it('el catálogo de SUPERADMIN incluye los deshabilitados', async () => {
      prismaMock.mailProvider.findMany.mockResolvedValue([]);

      await service.findAllForAdmin();

      const callArg = prismaMock.mailProvider.findMany.mock.calls[0][0];
      expect(callArg).not.toHaveProperty('where');
    });
  });
});
