import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { ExportPurchaseBookService } from './export-purchase-book.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ExportPurchaseBookDto } from '../dto/export-purchase-book.dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MAX_ROWS = 20_000;

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

const adminCtx: TenantContext = {
  tenantId: TENANT_ID,
  tenantSlug: 'tenant-a',
  actor: { type: 'user', id: 'user-1', role: Role.ADMIN },
};

const superadminCtx: TenantContext = {
  tenantId: null,
  tenantSlug: null,
  actor: { type: 'user', id: 'root', role: Role.SUPERADMIN },
};

/** Documento tal como lo devuelve DOCUMENT_EXPORT_SELECT. */
function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    fecEmi: new Date('2026-05-28T00:00:00.000Z'),
    tipoDte: '03',
    codigoGeneracion: '0B4E2221-74CF-4550-A451-31BBFB5CC9FD',
    emisorNit: '027561310',
    emisorNombre: 'LUIS ANTONIO TURCIOS ALVAREZ',
    totalExenta: d(0),
    totalNoSuj: d(0),
    totalGravada: d('144'),
    ivaCreditoFiscal: d('18.72'),
    montoTotalOperacion: d('162.72'),
    anexoTipoOperacion: null,
    anexoClasificacion: null,
    anexoSector: null,
    anexoTipoCostoGasto: null,
    receptor: {
      defaultTipoOperacion: 1,
      defaultClasificacion: 2,
      defaultSector: 4,
      defaultTipoCostoGasto: 2,
    },
    ...overrides,
  };
}

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  purchaseDocument: { count: jest.fn(), findMany: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

const configMock = { purchaseBookExportMaxRows: MAX_ROWS };
const loggerMock = { setContext: jest.fn(), warn: jest.fn(), info: jest.fn() };

function exportDto(overrides: Partial<ExportPurchaseBookDto> = {}): ExportPurchaseBookDto {
  return Object.assign(
    new ExportPurchaseBookDto(),
    { format: 'csv', page: 1, limit: 50 },
    overrides,
  );
}

describe('ExportPurchaseBookService', () => {
  let service: ExportPurchaseBookService;

  /** Primer count = total; segundo = sin clasificar. */
  function mockCounts(total: number, unclassified = 0): void {
    prismaMock.purchaseDocument.count
      .mockResolvedValueOnce(total)
      .mockResolvedValueOnce(unclassified);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.purchaseDocument.findMany.mockResolvedValue([exportRow()]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExportPurchaseBookService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AppConfigService, useValue: configMock },
        { provide: PinoLogger, useValue: loggerMock },
      ],
    }).compile();

    service = moduleRef.get(ExportPurchaseBookService);
  });

  describe('guardas previas al streaming', () => {
    it('rechaza un filtro vacío antes de tocar la respuesta', async () => {
      mockCounts(0);
      await expect(service.collectRows(adminCtx, exportDto())).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prismaMock.purchaseDocument.findMany).not.toHaveBeenCalled();
    });

    it('rechaza un filtro por encima del tope de filas', async () => {
      mockCounts(MAX_ROWS + 1);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        response: { error: 'EXPORT_TOO_LARGE' },
      });
      expect(prismaMock.purchaseDocument.findMany).not.toHaveBeenCalled();
    });

    it('rechaza si hay compras sin clasificar', async () => {
      mockCounts(10, 3);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        response: { error: 'PURCHASE_BOOK_UNCLASSIFIED' },
      });
    });

    it('permite exportar sin clasificar cuando se pide explícitamente', async () => {
      mockCounts(1, 1);

      const result = await service.collectRows(adminCtx, exportDto({ allowUnclassified: true }));
      expect(result.rows).toHaveLength(1);
    });

    it('SUPERADMIN no exporta el libro de un tenant', async () => {
      await expect(service.collectRows(superadminCtx, exportDto())).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('recolección de filas', () => {
    it('arma la fila del anexo con los defaults del receptor', async () => {
      mockCounts(1);

      const { rows } = await service.collectRows(adminCtx, exportDto());

      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveLength(21);
      // Columna O = suma de G a M = 144.00, sin el crédito fiscal de N.
      expect(rows[0][14].value).toBe('144.00');
      expect(rows[0][16].value).toBe('1');
    });

    it('ordena por fecha de emisión ascendente', async () => {
      mockCounts(1);
      await service.collectRows(adminCtx, exportDto());

      expect(prismaMock.purchaseDocument.findMany.mock.calls[0][0].orderBy).toEqual([
        { fecEmi: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('nunca consulta sin take: siempre pagina', async () => {
      mockCounts(1);
      await service.collectRows(adminCtx, exportDto());

      expect(prismaMock.purchaseDocument.findMany.mock.calls[0][0].take).toBe(500);
    });

    it('recorre por cursor cuando hay más de un lote', async () => {
      mockCounts(501);
      const firstBatch = Array.from({ length: 500 }, (_, i) => exportRow({ id: `doc-${i}` }));
      prismaMock.purchaseDocument.findMany
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([exportRow({ id: 'doc-500' })]);

      const { rows } = await service.collectRows(adminCtx, exportDto());

      expect(rows).toHaveLength(501);
      const secondCall = prismaMock.purchaseDocument.findMany.mock.calls[1][0];
      expect(secondCall.cursor).toEqual({ id: 'doc-499' });
      expect(secondCall.skip).toBe(1);
    });

    it('corta el recorrido si la base devuelve menos de lo esperado', async () => {
      mockCounts(1000);
      prismaMock.purchaseDocument.findMany.mockResolvedValueOnce([exportRow()]);

      const { rows } = await service.collectRows(adminCtx, exportDto());

      expect(rows).toHaveLength(1);
      expect(prismaMock.purchaseDocument.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('anomalías', () => {
    it('no reporta ninguna con un documento sano', async () => {
      mockCounts(1);
      const { anomalies } = await service.collectRows(adminCtx, exportDto());

      expect(anomalies).toEqual({
        supplierId: 0,
        negativeAmount: 0,
        totalMismatch: 0,
        incompleteClassification: 0,
      });
    });

    it('cuenta un identificador de proveedor con longitud inesperada', async () => {
      mockCounts(1);
      prismaMock.purchaseDocument.findMany.mockResolvedValue([exportRow({ emisorNit: '123' })]);

      const { anomalies } = await service.collectRows(adminCtx, exportDto());

      expect(anomalies.supplierId).toBe(1);
      expect(loggerMock.warn).toHaveBeenCalled();
    });

    it('cuenta cuando O + N no reconstruye el total del documento', async () => {
      mockCounts(1);
      prismaMock.purchaseDocument.findMany.mockResolvedValue([
        exportRow({ montoTotalOperacion: d('999.99') }),
      ]);

      const { anomalies } = await service.collectRows(adminCtx, exportDto());
      expect(anomalies.totalMismatch).toBe(1);
    });
  });

  describe('buildFileName', () => {
    it('usa el mes cuando el filtro es por período', () => {
      expect(service.buildFileName(exportDto({ month: '2026-05' }), 'csv')).toBe(
        'compras_2026-05.csv',
      );
    });

    it('usa la fecha inicial cuando el filtro es por rango', () => {
      expect(service.buildFileName(exportDto({ from: '2026-05-01' }), 'xlsx')).toBe(
        'compras_2026-05-01.xlsx',
      );
    });

    it('el nombre no contiene separadores de ruta', () => {
      const name = service.buildFileName(exportDto({ month: '2026-05' }), 'csv');
      expect(name).not.toMatch(/[/\\]/);
    });
  });
});
