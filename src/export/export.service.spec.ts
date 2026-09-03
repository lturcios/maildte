import { Test } from '@nestjs/testing';
import { buildExportWhere, ExportService } from './export.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

describe('ExportService', () => {
  let service: ExportService;
  let storage: { resolveSafe: jest.Mock };

  beforeEach(async () => {
    storage = { resolveSafe: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = moduleRef.get(ExportService);
  });

  describe('isMissing', () => {
    const TENANT_SLUG = 'acme';

    it('retorna true si el archivo no existe en disco', () => {
      storage.resolveSafe.mockReturnValue(__filename + '.no-existe');
      expect(service.isMissing(TENANT_SLUG, 'acme/cuenta/2026-08/json/no-existe.json')).toBe(true);
    });

    it('retorna false si el archivo sí existe en disco', () => {
      storage.resolveSafe.mockReturnValue(__filename);
      expect(service.isMissing(TENANT_SLUG, 'acme/cuenta/2026-08/json/existe.json')).toBe(false);
    });

    it('un relativePath fuera de STORAGE_ROOT (resolveSafe lanza) se trata como missing, no rompe la request', () => {
      storage.resolveSafe.mockImplementation(() => {
        throw new Error('Ruta fuera del área de almacenamiento');
      });
      expect(service.isMissing(TENANT_SLUG, '../../etc/passwd')).toBe(true);
    });
  });
});

describe('buildExportWhere', () => {
  const TENANT_ID = 'tenant-1';
  const ACCOUNT_ID = 'account-1';

  it('receivedFrom/receivedTo filtran por la fecha de recepción del correo, no por la de archivado', () => {
    const where = buildExportWhere(TENANT_ID, {
      accountId: ACCOUNT_ID,
      receivedFrom: '2026-03-01',
      receivedTo: '2026-03-31',
    });

    expect(where.email).toEqual({
      accountId: ACCOUNT_ID,
      receivedAt: {
        gte: new Date('2026-03-01T00:00:00.000Z'),
        lte: new Date('2026-03-31T23:59:59.999Z'),
      },
    });
    // Nada toca createdAt: un sync corrido en agosto no debe vaciar un rango de marzo.
    expect(where.createdAt).toBeUndefined();
  });

  it('el día "hasta" entra completo en el rango (regresión: se descartaba el último día)', () => {
    const where = buildExportWhere(TENANT_ID, { accountId: ACCOUNT_ID, receivedTo: '2026-03-31' });
    const receivedAt = where.email?.receivedAt as { lte: Date };
    expect(new Date('2026-03-31T20:15:00.000Z') <= receivedAt.lte).toBe(true);
  });

  it('since/until siguen filtrando por createdAt (cursor incremental del CLI, RF-07.1)', () => {
    const where = buildExportWhere(TENANT_ID, {
      accountId: ACCOUNT_ID,
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-31T00:00:00.000Z',
    });

    expect(where.createdAt).toEqual({
      gt: new Date('2026-08-01T00:00:00.000Z'),
      lte: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(where.email).toEqual({ accountId: ACCOUNT_ID });
  });

  it('los dos ejes de tiempo se combinan en vez de pisarse', () => {
    const where = buildExportWhere(TENANT_ID, {
      accountId: ACCOUNT_ID,
      since: '2026-08-01T00:00:00.000Z',
      receivedFrom: '2026-03-01',
    });

    expect(where.createdAt).toEqual({ gt: new Date('2026-08-01T00:00:00.000Z') });
    expect(where.email).toEqual({
      accountId: ACCOUNT_ID,
      receivedAt: { gte: new Date('2026-03-01T00:00:00.000Z') },
    });
  });

  it('month filtra por monthFolder y convive con el rango de recepción', () => {
    const where = buildExportWhere(TENANT_ID, {
      accountId: ACCOUNT_ID,
      month: '2026-03',
      receivedFrom: '2026-03-10',
    });

    expect(where.email).toEqual({
      accountId: ACCOUNT_ID,
      monthFolder: '2026-03',
      receivedAt: { gte: new Date('2026-03-10T00:00:00.000Z') },
    });
  });

  it('sin filtros de tiempo, el scope es solo tenant + cuenta', () => {
    const where = buildExportWhere(TENANT_ID, { accountId: ACCOUNT_ID });
    expect(where).toEqual({ tenantId: TENANT_ID, email: { accountId: ACCOUNT_ID } });
  });
});
