import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import {
  buildPurchaseDocumentWhere,
  buildUnclassifiedWhere,
  PurchaseBookService,
} from './purchase-book.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { DteEnqueuer } from './queue/dte-enqueuer';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ListPurchaseDocumentsDto } from './dto/list-purchase-documents.dto';
import { ReprocessDto } from './dto/reprocess.dto';
import { PARSER_VERSION } from './parser/dte-parser';
import { ANEXO_CLASSIFICATION_EPOCH } from './anexo/resolve-classification';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const adminCtx: TenantContext = {
  tenantId: TENANT_ID,
  tenantSlug: 'tenant-a',
  actor: { type: 'user', id: 'user-1', role: Role.ADMIN },
};

const miembroCtx: TenantContext = {
  ...adminCtx,
  actor: { type: 'user', id: 'user-2', role: Role.MIEMBRO },
};

const superadminCtx: TenantContext = {
  tenantId: null,
  tenantSlug: null,
  actor: { type: 'user', id: 'root', role: Role.SUPERADMIN },
};

function listDto(overrides: Partial<ListPurchaseDocumentsDto> = {}): ListPurchaseDocumentsDto {
  return Object.assign(new ListPurchaseDocumentsDto(), { page: 1, limit: 50 }, overrides);
}

describe('buildPurchaseDocumentWhere', () => {
  it('siempre filtra por tenantId, aunque no venga ningún filtro', () => {
    expect(buildPurchaseDocumentWhere(TENANT_ID, listDto())).toEqual({ tenantId: TENANT_ID });
  });

  it('aplica los filtros de emisor, receptor y cuenta', () => {
    const where = buildPurchaseDocumentWhere(
      TENANT_ID,
      listDto({ emisorId: 'e-1', receptorId: 'r-1', accountId: 'a-1' }),
    );
    expect(where).toMatchObject({ emisorId: 'e-1', receptorId: 'r-1', accountId: 'a-1' });
  });

  describe('rango de fechas', () => {
    it('filtra por fecEmi con from y to', () => {
      const where = buildPurchaseDocumentWhere(
        TENANT_ID,
        listDto({ from: '2026-05-01', to: '2026-05-31' }),
      );
      expect(where.fecEmi).toEqual({
        gte: new Date('2026-05-01T00:00:00.000Z'),
        lte: new Date('2026-05-31T00:00:00.000Z'),
      });
    });

    it('acepta solo el extremo inferior', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ from: '2026-05-01' }));
      expect(where.fecEmi).toEqual({ gte: new Date('2026-05-01T00:00:00.000Z') });
    });

    it('expande month al mes completo', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ month: '2026-05' }));
      expect(where.fecEmi).toEqual({
        gte: new Date('2026-05-01T00:00:00.000Z'),
        lte: new Date('2026-05-31T00:00:00.000Z'),
      });
    });

    it('resuelve el último día de febrero en año bisiesto', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ month: '2024-02' }));
      expect(where.fecEmi).toEqual({
        gte: new Date('2024-02-01T00:00:00.000Z'),
        lte: new Date('2024-02-29T00:00:00.000Z'),
      });
    });

    it('resuelve el último día de febrero en año no bisiesto', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ month: '2026-02' }));
      expect((where.fecEmi as { lte: Date }).lte).toEqual(new Date('2026-02-28T00:00:00.000Z'));
    });

    it('month tiene precedencia sobre from y to', () => {
      const where = buildPurchaseDocumentWhere(
        TENANT_ID,
        listDto({ month: '2026-05', from: '2020-01-01', to: '2020-12-31' }),
      );
      expect((where.fecEmi as { gte: Date }).gte).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    });
  });

  describe('búsqueda libre', () => {
    it('busca en número de control, código de generación y proveedor', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ q: 'ltsoft' }));
      expect(where.OR).toEqual([
        { numeroControl: { contains: 'ltsoft', mode: 'insensitive' } },
        { codigoGeneracion: { contains: 'ltsoft', mode: 'insensitive' } },
        { emisorNombre: { contains: 'ltsoft', mode: 'insensitive' } },
      ]);
    });

    it('ignora una búsqueda de solo espacios', () => {
      expect(buildPurchaseDocumentWhere(TENANT_ID, listDto({ q: '   ' })).OR).toBeUndefined();
    });
  });

  describe('filtro de clasificación', () => {
    it('no agrega condiciones con "all"', () => {
      const where = buildPurchaseDocumentWhere(TENANT_ID, listDto({ classification: 'all' }));
      expect(where.AND).toBeUndefined();
    });

    it('"unclassified" limita al período con Q–T vigentes', () => {
      const where = buildPurchaseDocumentWhere(
        TENANT_ID,
        listDto({ classification: 'unclassified' }),
      );
      const and = where.AND as Prisma.PurchaseDocumentWhereInput[];
      expect(and[0]).toEqual({ fecEmi: { gte: ANEXO_CLASSIFICATION_EPOCH } });
      expect(and[1].OR).toHaveLength(4);
    });

    it('no pisa el OR de la búsqueda libre', () => {
      const where = buildPurchaseDocumentWhere(
        TENANT_ID,
        listDto({ q: 'abc', classification: 'unclassified' }),
      );
      expect(where.OR).toHaveLength(3);
      expect(where.AND).toBeDefined();
    });
  });
});

describe('buildUnclassifiedWhere', () => {
  it('conserva el filtro base y agrega las condiciones de pendientes', () => {
    const base = buildPurchaseDocumentWhere(TENANT_ID, listDto({ receptorId: 'r-1' }));
    const where = buildUnclassifiedWhere(base);

    expect(where.tenantId).toBe(TENANT_ID);
    expect(where.receptorId).toBe('r-1');
    const and = where.AND as Prisma.PurchaseDocumentWhereInput[];
    expect(and).toContainEqual({ fecEmi: { gte: ANEXO_CLASSIFICATION_EPOCH } });
  });
});

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  purchaseDocument: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    update: jest.fn(),
  },
  dteParseResult: { findMany: jest.fn(), count: jest.fn() },
  attachment: { findMany: jest.fn(), count: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

const enqueuerMock = { enqueueParseBulk: jest.fn() };
const loggerMock = {
  setContext: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const configMock = { purchaseBookReprocessBatch: 1000 };

describe('PurchaseBookService', () => {
  let service: PurchaseBookService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.purchaseDocument.findMany.mockResolvedValue([]);
    prismaMock.purchaseDocument.count.mockResolvedValue(0);
    prismaMock.purchaseDocument.findFirst.mockResolvedValue({ id: 'doc-1', rawJson: { a: 1 } });
    prismaMock.purchaseDocument.update.mockResolvedValue({ id: 'doc-1' });
    prismaMock.attachment.findMany.mockResolvedValue([]);
    prismaMock.attachment.count.mockResolvedValue(0);
    enqueuerMock.enqueueParseBulk.mockImplementation((targets: unknown[]) =>
      Promise.resolve(targets.length),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        PurchaseBookService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AppConfigService, useValue: configMock },
        { provide: DteEnqueuer, useValue: enqueuerMock },
        { provide: PinoLogger, useValue: loggerMock },
      ],
    }).compile();

    service = moduleRef.get(PurchaseBookService);
  });

  describe('aislamiento por tenant', () => {
    it('SUPERADMIN no accede al libro de un tenant', async () => {
      await expect(service.findAll(superadminCtx, listDto())).rejects.toThrow(ForbiddenException);
      await expect(service.summary(superadminCtx, listDto())).rejects.toThrow(ForbiddenException);
      await expect(service.findOne(superadminCtx, 'doc-1')).rejects.toThrow(ForbiddenException);
    });

    it('el listado siempre corre dentro del contexto del tenant', async () => {
      await service.findAll(adminCtx, listDto());
      expect(prismaMock.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    });

    it('un documento de otro tenant devuelve 404, no 403', async () => {
      prismaMock.purchaseDocument.findFirst.mockResolvedValue(null);
      await expect(service.findOne(adminCtx, 'ajeno')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('pagina y ordena por fecha de emisión descendente', async () => {
      prismaMock.purchaseDocument.count.mockResolvedValue(120);

      const result = await service.findAll(adminCtx, listDto({ page: 2, limit: 50 }));

      const args = prismaMock.purchaseDocument.findMany.mock.calls[0][0];
      expect(args.skip).toBe(50);
      expect(args.take).toBe(50);
      expect(args.orderBy).toEqual([{ fecEmi: 'desc' }, { createdAt: 'desc' }]);
      expect(result.meta).toEqual({ page: 2, limit: 50, total: 120 });
    });

    it('no trae rawJson en el listado', async () => {
      await service.findAll(adminCtx, listDto());
      const select = prismaMock.purchaseDocument.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('rawJson');
      expect(select).not.toHaveProperty('items');
    });
  });

  describe('summary', () => {
    beforeEach(() => {
      prismaMock.purchaseDocument.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _sum: {
          totalExenta: new Prisma.Decimal('10.5'),
          totalNoSuj: new Prisma.Decimal(0),
          totalGravada: new Prisma.Decimal('320.99'),
          ivaCreditoFiscal: new Prisma.Decimal('41.73'),
          montoTotalOperacion: new Prisma.Decimal('373.22'),
        },
      });
    });

    it('serializa los montos como string, sin pasar por float', async () => {
      const summary = await service.summary(adminCtx, listDto());

      expect(summary.documentCount).toBe(3);
      expect(summary.totalGravada).toBe('320.99');
      expect(summary.ivaCreditoFiscal).toBe('41.73');
    });

    it('devuelve cero cuando no hay documentos en el filtro', async () => {
      prismaMock.purchaseDocument.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: {
          totalExenta: null,
          totalNoSuj: null,
          totalGravada: null,
          ivaCreditoFiscal: null,
          montoTotalOperacion: null,
        },
      });

      const summary = await service.summary(adminCtx, listDto());
      expect(summary.totalGravada).toBe('0');
      expect(summary.documentCount).toBe(0);
    });

    it('cuenta los adjuntos JSON que todavía no pasaron por el parser', async () => {
      prismaMock.attachment.count.mockResolvedValue(7);

      const summary = await service.summary(adminCtx, listDto());

      expect(summary.jsonAttachmentsWithoutParse).toBe(7);
      expect(prismaMock.attachment.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, fileType: 'JSON', parseResult: { is: null } },
      });
    });
  });

  describe('findOne', () => {
    it('incluye rawJson para ADMIN', async () => {
      const doc = await service.findOne(adminCtx, 'doc-1');
      expect(doc.rawJson).toEqual({ a: 1 });
    });

    it('oculta rawJson para MIEMBRO', async () => {
      const doc = await service.findOne(miembroCtx, 'doc-1');
      expect(doc.rawJson).toBeNull();
      const select = prismaMock.purchaseDocument.findFirst.mock.calls[0][0].select;
      expect(select.rawJson).toBe(false);
    });

    it('filtra por id y tenantId a la vez', async () => {
      await service.findOne(adminCtx, 'doc-1');
      expect(prismaMock.purchaseDocument.findFirst.mock.calls[0][0].where).toEqual({
        id: 'doc-1',
        tenantId: TENANT_ID,
      });
    });
  });

  describe('updateClassification', () => {
    it('registra quién y cuándo clasificó', async () => {
      await service.updateClassification(adminCtx, 'doc-1', { anexoSector: 2 });

      const data = prismaMock.purchaseDocument.update.mock.calls[0][0].data;
      expect(data.anexoSector).toBe(2);
      expect(data.classifiedById).toBe('user-1');
      expect(data.classifiedAt).toBeInstanceOf(Date);
    });

    it('un null explícito limpia el override', async () => {
      await service.updateClassification(adminCtx, 'doc-1', { anexoSector: null });
      expect(prismaMock.purchaseDocument.update.mock.calls[0][0].data.anexoSector).toBeNull();
    });

    it('no toca las columnas ausentes del body', async () => {
      await service.updateClassification(adminCtx, 'doc-1', { anexoSector: 2 });

      const data = prismaMock.purchaseDocument.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('anexoTipoOperacion');
      expect(data).not.toHaveProperty('anexoClasificacion');
    });

    it('404 si el documento no es del tenant', async () => {
      prismaMock.purchaseDocument.findFirst.mockResolvedValue(null);
      await expect(
        service.updateClassification(adminCtx, 'ajeno', { anexoSector: 2 }),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.purchaseDocument.update).not.toHaveBeenCalled();
    });
  });

  describe('reprocess', () => {
    function reprocessDto(overrides: Partial<ReprocessDto> = {}): ReprocessDto {
      return Object.assign(new ReprocessDto(), { mode: 'missing' }, overrides);
    }

    it('encola los adjuntos y devuelve el conteo', async () => {
      prismaMock.attachment.findMany.mockResolvedValue([{ id: 'att-1' }, { id: 'att-2' }]);

      const result = await service.reprocess(adminCtx, reprocessDto());

      expect(result).toEqual({ enqueued: 2, nextCursor: null });
      expect(enqueuerMock.enqueueParseBulk).toHaveBeenCalledWith(
        [
          { tenantId: TENANT_ID, attachmentId: 'att-1' },
          { tenantId: TENANT_ID, attachmentId: 'att-2' },
        ],
        'reprocess',
        false,
      );
    });

    it('devuelve nextCursor cuando hay más páginas', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: `att-${i}` }));
      prismaMock.attachment.findMany.mockResolvedValue(rows);

      const result = await service.reprocess(adminCtx, reprocessDto({ limit: 2 }));

      expect(result.enqueued).toBe(2);
      expect(result.nextCursor).toBe('att-1');
    });

    it('pide un registro extra para saber si hay más', async () => {
      await service.reprocess(adminCtx, reprocessDto({ limit: 10 }));
      expect(prismaMock.attachment.findMany.mock.calls[0][0].take).toBe(11);
    });

    it('recorta el límite al máximo configurado', async () => {
      await service.reprocess(adminCtx, reprocessDto({ limit: 5000 }));
      expect(prismaMock.attachment.findMany.mock.calls[0][0].take).toBe(1001);
    });

    it('modo missing busca solo adjuntos sin ledger', async () => {
      await service.reprocess(adminCtx, reprocessDto({ mode: 'missing' }));
      const where = prismaMock.attachment.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        tenantId: TENANT_ID,
        fileType: 'JSON',
        parseResult: { is: null },
      });
    });

    it('modo failed incluye los errores y las versiones viejas del parser', async () => {
      await service.reprocess(adminCtx, reprocessDto({ mode: 'failed' }));
      const where = prismaMock.attachment.findMany.mock.calls[0][0].where;
      expect(where.OR).toContainEqual({
        parseResult: { parserVersion: { lt: PARSER_VERSION } },
      });
    });

    it('modo all encola con force para re-parsear todo', async () => {
      prismaMock.attachment.findMany.mockResolvedValue([{ id: 'att-1' }]);
      await service.reprocess(adminCtx, reprocessDto({ mode: 'all' }));

      expect(enqueuerMock.enqueueParseBulk).toHaveBeenCalledWith(
        expect.anything(),
        'reprocess',
        true,
      );
      const where = prismaMock.attachment.findMany.mock.calls[0][0].where;
      expect(where.parseResult).toBeUndefined();
      expect(where.OR).toBeUndefined();
    });

    it('filtra por cuenta y mes del correo', async () => {
      await service.reprocess(adminCtx, reprocessDto({ accountId: 'acc-1', month: '2026-05' }));
      const where = prismaMock.attachment.findMany.mock.calls[0][0].where;
      expect(where.email).toEqual({ accountId: 'acc-1', monthFolder: '2026-05' });
    });

    it('SUPERADMIN no puede reprocesar', async () => {
      await expect(service.reprocess(superadminCtx, reprocessDto())).rejects.toThrow(
        ForbiddenException,
      );
    });

    /**
     * Regresión del punto ciego que dejó el libro de compras vacío durante siete
     * fases: `enqueueParseBulk` no lanza, devuelve cuántos trabajos aceptó la
     * cola, y nadie comparaba ese número contra lo pedido. Acá hay una persona
     * esperando la respuesta HTTP, así que devolver `{ enqueued: 0 }` con un 201
     * le diría "no había nada que reprocesar" cuando en realidad se perdió el
     * lote entero. 503 porque la cola no acepta trabajo: reintentar más tarde.
     */
    it('503 PURCHASE_BOOK_QUEUE_UNAVAILABLE si la cola no acepta el lote', async () => {
      prismaMock.attachment.findMany.mockResolvedValue([{ id: 'att-1' }, { id: 'att-2' }]);
      enqueuerMock.enqueueParseBulk.mockResolvedValue(0);

      await expect(service.reprocess(adminCtx, reprocessDto())).rejects.toMatchObject({
        response: {
          error: 'PURCHASE_BOOK_QUEUE_UNAVAILABLE',
          message: expect.stringContaining('cola de procesamiento'),
        },
      });
      await expect(service.reprocess(adminCtx, reprocessDto())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ requested: 2, enqueued: 0 }),
        expect.stringContaining('el lote se perdió'),
      );
    });

    it('también falla si la cola acepta solo una parte del lote', async () => {
      prismaMock.attachment.findMany.mockResolvedValue([{ id: 'att-1' }, { id: 'att-2' }]);
      enqueuerMock.enqueueParseBulk.mockResolvedValue(1);

      await expect(service.reprocess(adminCtx, reprocessDto())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    /**
     * El contrapunto obligatorio del caso anterior: "no hay nada que encolar" es
     * un 0 legítimo y NO puede confundirse con "se perdió el lote". Sin esta
     * guarda, un tenant con todo parseado recibiría un 503 en cada llamada.
     */
    it('no falla cuando no hay ningún adjunto que encolar', async () => {
      prismaMock.attachment.findMany.mockResolvedValue([]);
      enqueuerMock.enqueueParseBulk.mockResolvedValue(0);

      await expect(service.reprocess(adminCtx, reprocessDto())).resolves.toEqual({
        enqueued: 0,
        nextCursor: null,
      });
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  });
});
