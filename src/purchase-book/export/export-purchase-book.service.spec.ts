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
const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';
const OTRO_RECEPTOR_ID = '33333333-3333-3333-3333-333333333333';
const RECEPTOR_NIT = '06140203901028';
const CANONICAL_KEY = '1435153';
const HERMANA_ID = '44444444-4444-4444-4444-444444444444';
const HERMANA_NIT = '022560911';

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
    receptorNit: RECEPTOR_NIT,
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
  purchaseDocument: { count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  dteParty: { findFirst: jest.fn(), findMany: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

const configMock = { purchaseBookExportMaxRows: MAX_ROWS };
const loggerMock = { setContext: jest.fn(), warn: jest.fn(), info: jest.fn() };

/**
 * `receptorId` es obligatorio en el export: el Anexo 3 se presenta por
 * contribuyente, así que ningún caso de prueba representa un filtro válido sin
 * receptor.
 */
function exportDto(overrides: Partial<ExportPurchaseBookDto> = {}): ExportPurchaseBookDto {
  return Object.assign(
    new ExportPurchaseBookDto(),
    { format: 'csv', receptorId: RECEPTOR_ID, page: 1, limit: 50 },
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
    // Un solo receptor: el caso sano de la guarda fiscal.
    prismaMock.purchaseDocument.groupBy.mockResolvedValue([{ receptorId: RECEPTOR_ID }]);
    // Receptor con clave canónica y sin partes hermanas: el caso sano de la
    // guarda de identidad partida. Con clave (y no sin ella) para que el camino
    // de búsqueda de hermanas se ejecute en todos los tests, no solo en los suyos.
    prismaMock.dteParty.findFirst.mockResolvedValue({ canonicalKey: CANONICAL_KEY });
    prismaMock.dteParty.findMany.mockResolvedValue([]);

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

    it('rechaza un export sin receptor sin tocar la base', async () => {
      // El DTO ya lo exige, pero esa validación falló una vez en silencio por
      // herencia de decoradores. El servicio no confía en ella para una
      // condición de validez fiscal del archivo.
      const sinReceptor = exportDto();
      delete (sinReceptor as Partial<ExportPurchaseBookDto>).receptorId;

      await expect(service.collectRows(adminCtx, sinReceptor)).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_BOOK_RECEPTOR_REQUIRED' },
      });
      expect(prismaMock.purchaseDocument.count).not.toHaveBeenCalled();
      expect(prismaMock.purchaseDocument.groupBy).not.toHaveBeenCalled();
      expect(prismaMock.purchaseDocument.findMany).not.toHaveBeenCalled();
    });

    /**
     * Este caso NO es alcanzable por HTTP: `receptorId` es obligatorio y entra
     * al `where` como igualdad, así que el `groupBy` solo puede devolver 0 o 1
     * grupo. El escenario se fuerza con el mock a propósito, porque la guarda
     * existe como red contra una regresión de `buildPurchaseDocumentWhere`, no
     * como validación de un uso normal. Verifica la lógica de la rama en
     * aislamiento: no detecta que alguien rompa el armado del `where`.
     */
    /**
     * Gate de la fase 2 del Addendum 11. El mismo contribuyente existe como dos
     * partes porque unos proveedores lo identifican con el NIT de 14 dígitos y
     * otros con el homologado al DUI, de 9. Exportar una de ellas deja las
     * compras de la otra fuera de la declaración **sin ningún error**: el
     * archivo se ve normal y está incompleto. La regla es incluir a las dos o
     * fallar de forma explícita; nunca exportar una y omitir la otra.
     */
    it('rechaza el export cuando el receptor tiene una parte hermana con compras en el filtro', async () => {
      mockCounts(849);
      prismaMock.dteParty.findMany.mockResolvedValue([{ id: HERMANA_ID, nit: HERMANA_NIT }]);
      prismaMock.purchaseDocument.count.mockResolvedValueOnce(7);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_BOOK_SPLIT_RECEPTOR' },
      });
      // Ni una fila emitida: la guarda corre antes de armar el archivo.
      expect(prismaMock.purchaseDocument.findMany).not.toHaveBeenCalled();
    });

    it('cuenta las compras excluidas con el filtro del export, no con el histórico de la hermana', async () => {
      // Una hermana con compras en OTRO período no afecta esta declaración. Si
      // el conteo fuera "¿tiene documentos en algún lado?", el aviso sonaría
      // cuando no pasa nada, y un aviso así enseña a ignorarlo.
      mockCounts(849);
      prismaMock.dteParty.findMany.mockResolvedValue([{ id: HERMANA_ID, nit: HERMANA_NIT }]);
      prismaMock.purchaseDocument.count.mockResolvedValueOnce(0);

      const result = await service.collectRows(adminCtx, exportDto({ month: '2026-05' }));

      expect(result.rows).toHaveLength(1);
      const excludedCall = prismaMock.purchaseDocument.count.mock.calls[2][0] as {
        where: Record<string, unknown>;
      };
      expect(excludedCall.where).toMatchObject({
        tenantId: TENANT_ID,
        receptorId: { in: [HERMANA_ID] },
      });
      // El rango del filtro viaja al conteo: es el mismo período del export.
      expect(excludedCall.where.fecEmi).toBeDefined();
    });

    it('no bloquea a un receptor sin clave canónica ni busca hermanas', async () => {
      // La cascada NRC > NIT-14 > DUI-9 no lo cubrió. No se le inventa una
      // identidad para bloquearle el export.
      mockCounts(1);
      prismaMock.dteParty.findFirst.mockResolvedValue({ canonicalKey: null });

      const result = await service.collectRows(adminCtx, exportDto());

      expect(result.rows).toHaveLength(1);
      expect(prismaMock.dteParty.findMany).not.toHaveBeenCalled();
    });

    it('rechaza un conjunto que mezcla compras de más de un receptor', async () => {
      mockCounts(2);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { receptorId: RECEPTOR_ID },
        { receptorId: OTRO_RECEPTOR_ID },
      ]);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_BOOK_MULTIPLE_RECEPTORS' },
      });
      expect(prismaMock.purchaseDocument.findMany).not.toHaveBeenCalled();
    });

    it('la guarda de receptor no se adelanta al filtro vacío', async () => {
      // Con el filtro vacío, el error accionable es PURCHASE_BOOK_EMPTY: la
      // guarda de receptor nunca debe recorrer un conjunto sin acotar.
      mockCounts(0);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { receptorId: RECEPTOR_ID },
        { receptorId: OTRO_RECEPTOR_ID },
      ]);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        response: { error: 'PURCHASE_BOOK_EMPTY' },
      });
      expect(prismaMock.purchaseDocument.groupBy).not.toHaveBeenCalled();
    });

    it('la guarda de receptor no se adelanta al tope de filas', async () => {
      mockCounts(MAX_ROWS + 1);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { receptorId: RECEPTOR_ID },
        { receptorId: OTRO_RECEPTOR_ID },
      ]);

      await expect(service.collectRows(adminCtx, exportDto())).rejects.toMatchObject({
        response: { error: 'EXPORT_TOO_LARGE' },
      });
      expect(prismaMock.purchaseDocument.groupBy).not.toHaveBeenCalled();
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

    it('devuelve el NIT del receptor tomado de los documentos', async () => {
      mockCounts(1);

      const { receptorNit } = await service.collectRows(adminCtx, exportDto());

      expect(receptorNit).toBe(RECEPTOR_NIT);
      // Sin consulta extra: el NIT sale de las filas que ya se recorren.
      expect(prismaMock.purchaseDocument.findMany).toHaveBeenCalledTimes(1);
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
      expect(service.buildFileName(exportDto({ month: '2026-05' }), 'csv', RECEPTOR_NIT)).toBe(
        `compras_${RECEPTOR_NIT}_2026-05.csv`,
      );
    });

    it('usa la fecha inicial cuando el filtro es por rango', () => {
      expect(service.buildFileName(exportDto({ from: '2026-05-01' }), 'xlsx', RECEPTOR_NIT)).toBe(
        `compras_${RECEPTOR_NIT}_2026-05-01.xlsx`,
      );
    });

    it('incluye el NIT del receptor para distinguir el archivo de cada contribuyente', () => {
      const dto = exportDto({ month: '2026-05' });

      const unReceptor = service.buildFileName(dto, 'csv', RECEPTOR_NIT);
      const otroReceptor = service.buildFileName(dto, 'csv', '12171609731022');

      expect(unReceptor).toContain(RECEPTOR_NIT);
      expect(unReceptor).not.toBe(otroReceptor);
    });

    it('el nombre no contiene separadores de ruta', () => {
      const name = service.buildFileName(
        exportDto({ month: '2026-05' }),
        'csv',
        '../../etc/passwd',
      );
      expect(name).not.toMatch(/[/\\]/);
    });

    /**
     * El NIT viene del JSON del DTE, o sea de quien envía el correo, y el parser
     * solo exige que no esté vacío. Un punto de código sobre U+00FF hace que
     * `res.setHeader` lance `ERR_INVALID_CHAR`, y como el NIT queda persistido
     * el export de ese receptor devolvería 500 para siempre.
     */
    it('descarta del nombre cualquier carácter que rompa un header HTTP', () => {
      const name = service.buildFileName(exportDto({ month: '2026-05' }), 'csv', '0614🎉020390');

      expect(name).toBe('compras_0614020390_2026-05.csv');
      // Latin-1 es el límite de lo que Node acepta en el valor de un header.
      expect([...name].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
    });

    it('cae en un marcador cuando el NIT no deja nada utilizable', () => {
      const name = service.buildFileName(exportDto({ month: '2026-05' }), 'csv', '🎉');

      // Degrada el nombre en vez de fallar: la validez fiscal del archivo no
      // depende de cómo se llame.
      expect(name).toBe('compras_sin-nit_2026-05.csv');
    });
  });
});
