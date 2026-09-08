import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { DteParseStatus, Prisma } from '@prisma/client';
import { readFile, stat } from 'fs/promises';
import { BadRequestException } from '@nestjs/common';
import { DteIngestService } from './dte-ingest.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { AppConfigService } from '../../config/app-config.service';
import { PARSER_VERSION } from '../parser/dte-parser';
import ccfV3 from '../__fixtures__/ccf-v3.json';
import ccfV4 from '../__fixtures__/ccf-v4.json';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  stat: jest.fn(),
}));

const readFileMock = readFile as jest.MockedFunction<typeof readFile>;
const statMock = stat as jest.MockedFunction<typeof stat>;

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ATTACHMENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MAX_JSON_BYTES = 2_097_152;

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  tenant: { findUnique: jest.fn() },
  attachment: { findFirst: jest.fn() },
  dteParseResult: { findFirst: jest.fn(), upsert: jest.fn() },
  dteParty: { upsert: jest.fn() },
  purchaseDocument: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  purchaseDocumentItem: { createMany: jest.fn(), deleteMany: jest.fn() },
  purchaseDocumentTax: { createMany: jest.fn(), deleteMany: jest.fn() },
  purchaseDocumentPayment: { createMany: jest.fn(), deleteMany: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

const storageMock = {
  resolveSafe: jest.fn(),
};

const configMock = {
  dteMaxJsonBytes: MAX_JSON_BYTES,
};

/** Adjunto JSON válido, tal como lo devuelve la consulta del servicio. */
function attachmentRow(overrides: Partial<{ sizeBytes: number }> = {}) {
  return {
    id: ATTACHMENT_ID,
    emailId: 'email-1',
    relativePath: 'tenant-a/compras/2026-05/json/dte.json',
    sizeBytes: 3200,
    email: { accountId: 'account-1' },
    ...overrides,
  };
}

/** Devuelve el `data` con el que se llamó al upsert del ledger. */
function ledgerData(): Record<string, unknown> {
  const call = prismaMock.dteParseResult.upsert.mock.calls.at(-1);
  return (call?.[0] as { create: Record<string, unknown> }).create;
}

describe('DteIngestService', () => {
  let service: DteIngestService;

  beforeEach(async () => {
    jest.clearAllMocks();

    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.tenant.findUnique.mockResolvedValue({ slug: 'tenant-a', status: 'ACTIVO' });
    prismaMock.attachment.findFirst.mockResolvedValue(attachmentRow());
    prismaMock.dteParseResult.findFirst.mockResolvedValue(null);
    prismaMock.dteParseResult.upsert.mockResolvedValue({});
    prismaMock.dteParty.upsert.mockImplementation((args: { create: { nit: string } }) =>
      Promise.resolve({ id: `party-${args.create.nit}` }),
    );
    prismaMock.purchaseDocument.create.mockResolvedValue({ id: 'doc-1' });
    prismaMock.purchaseDocument.findFirst.mockResolvedValue(null);
    prismaMock.purchaseDocumentItem.createMany.mockResolvedValue({ count: 1 });
    prismaMock.purchaseDocumentTax.createMany.mockResolvedValue({ count: 1 });
    prismaMock.purchaseDocumentPayment.createMany.mockResolvedValue({ count: 1 });

    storageMock.resolveSafe.mockReturnValue('/storage/tenant-a/compras/2026-05/json/dte.json');
    statMock.mockResolvedValue({ size: 3200 } as Awaited<ReturnType<typeof stat>>);
    readFileMock.mockResolvedValue(JSON.stringify(ccfV4) as never);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DteIngestService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StorageService, useValue: storageMock },
        { provide: AppConfigService, useValue: configMock },
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

    service = moduleRef.get(DteIngestService);
  });

  describe('camino feliz', () => {
    it('persiste partes, documento e hijos y registra PARSEADO', async () => {
      const status = await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      expect(status).toBe(DteParseStatus.PARSEADO);
      expect(prismaMock.dteParty.upsert).toHaveBeenCalledTimes(2);
      expect(prismaMock.purchaseDocument.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.purchaseDocumentItem.createMany).toHaveBeenCalledTimes(1);
      expect(ledgerData()).toMatchObject({
        status: DteParseStatus.PARSEADO,
        documentId: 'doc-1',
        parserVersion: PARSER_VERSION,
        codigoGeneracion: '0B4E2221-74CF-4550-A451-31BBFB5CC9FD',
      });
    });

    it('marca al emisor y al receptor con su rol, sin pisar el otro', async () => {
      await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      const calls = prismaMock.dteParty.upsert.mock.calls.map(
        (call) => call[0] as { create: Record<string, unknown> },
      );
      expect(calls[0].create).toMatchObject({ nit: '027561310', seenAsEmisor: true });
      expect(calls[0].create).not.toHaveProperty('seenAsReceptor');
      expect(calls[1].create).toMatchObject({ nit: '06140203901028', seenAsReceptor: true });
    });

    it('guarda el rawJson y el snapshot del emisor en el documento', async () => {
      await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      const data = (
        prismaMock.purchaseDocument.create.mock.calls[0][0] as { data: Record<string, unknown> }
      ).data;
      expect(data.emisorNombre).toBe('LUIS ANTONIO TURCIOS ALVAREZ');
      expect(data.emisorNit).toBe('027561310');
      expect(data.rawJson).toBeDefined();
      expect(data.accountId).toBe('account-1');
      expect(data.tenantId).toBe(TENANT_ID);
    });

    it('escribe todo dentro de una sola transacción con contexto de tenant', async () => {
      await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      // Una para el tenant no (va fuera), una para el adjunto, una para el
      // ledger previo y una para toda la persistencia.
      const persistCall = prismaMock.withTenant.mock.calls.at(-1);
      expect(persistCall?.[0]).toBe(TENANT_ID);
    });

    it('procesa también la muestra v3 con sus alias de retención', async () => {
      readFileMock.mockResolvedValue(JSON.stringify(ccfV3) as never);

      const status = await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      expect(status).toBe(DteParseStatus.PARSEADO);
      const data = (
        prismaMock.purchaseDocument.create.mock.calls[0][0] as { data: Record<string, unknown> }
      ).data;
      expect((data.ivaRetenido as Prisma.Decimal).toString()).toBe('1.77');
    });
  });

  describe('idempotencia', () => {
    it('no vuelve a leer el disco si ya hay un resultado terminal de esta versión', async () => {
      prismaMock.dteParseResult.findFirst.mockResolvedValue({
        status: DteParseStatus.PARSEADO,
        parserVersion: PARSER_VERSION,
      });

      const status = await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      expect(status).toBeNull();
      expect(readFileMock).not.toHaveBeenCalled();
      expect(prismaMock.purchaseDocument.create).not.toHaveBeenCalled();
    });

    it('sí re-parsea si el ledger quedó con una versión anterior del parser', async () => {
      prismaMock.dteParseResult.findFirst.mockResolvedValue({
        status: DteParseStatus.PARSEADO,
        parserVersion: PARSER_VERSION - 1,
      });

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.PARSEADO,
      );
    });

    it('sí re-parsea un estado no terminal como ERROR', async () => {
      prismaMock.dteParseResult.findFirst.mockResolvedValue({
        status: DteParseStatus.ERROR,
        parserVersion: PARSER_VERSION,
      });

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.PARSEADO,
      );
    });

    it('con force reemplaza los hijos y NO toca los overrides del anexo', async () => {
      prismaMock.dteParseResult.findFirst.mockResolvedValue({
        status: DteParseStatus.PARSEADO,
        parserVersion: PARSER_VERSION,
      });
      prismaMock.purchaseDocument.findFirst.mockResolvedValue({ id: 'doc-existente' });
      prismaMock.purchaseDocument.update.mockResolvedValue({ id: 'doc-existente' });

      const status = await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID, { force: true });

      expect(status).toBe(DteParseStatus.PARSEADO);
      expect(prismaMock.purchaseDocumentItem.deleteMany).toHaveBeenCalledWith({
        where: { documentId: 'doc-existente' },
      });
      const updateData = (
        prismaMock.purchaseDocument.update.mock.calls[0][0] as { data: Record<string, unknown> }
      ).data;
      expect(updateData).not.toHaveProperty('anexoTipoOperacion');
      expect(updateData).not.toHaveProperty('anexoClasificacion');
      expect(updateData).not.toHaveProperty('classifiedById');
    });

    it('registra DUPLICADO cuando el codigoGeneracion ya existe en el tenant', async () => {
      prismaMock.purchaseDocument.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['tenantId', 'codigoGeneracion'] },
        }),
      );
      prismaMock.purchaseDocument.findFirst.mockResolvedValue({ id: 'doc-canonico' });

      const status = await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      expect(status).toBe(DteParseStatus.DUPLICADO);
      expect(ledgerData()).toMatchObject({
        status: DteParseStatus.DUPLICADO,
        documentId: 'doc-canonico',
      });
    });
  });

  describe('fallos deterministas: escriben ledger y no reintentan', () => {
    it('JSON inválido', async () => {
      readFileMock.mockResolvedValue('{ esto no es json' as never);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.JSON_INVALIDO,
      );
      expect(prismaMock.purchaseDocument.create).not.toHaveBeenCalled();
    });

    it('JSON que no es un DTE', async () => {
      readFileMock.mockResolvedValue('{"hola":"mundo"}' as never);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.NO_ES_DTE,
      );
    });

    it('tipo de DTE distinto de 03, conservando el tipo en el ledger', async () => {
      const raw = JSON.parse(JSON.stringify(ccfV4));
      raw.identificacion.tipoDte = '01';
      readFileMock.mockResolvedValue(JSON.stringify(raw) as never);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.IGNORADO_TIPO,
      );
      expect(ledgerData()).toMatchObject({ tipoDte: '01', version: 4 });
    });

    it('versión de esquema no soportada', async () => {
      const raw = JSON.parse(JSON.stringify(ccfV4));
      raw.identificacion.version = 2;
      readFileMock.mockResolvedValue(JSON.stringify(raw) as never);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.VERSION_NO_SOPORTADA,
      );
    });

    it('documento inválido, con el detalle de los campos en el ledger', async () => {
      const raw = JSON.parse(JSON.stringify(ccfV4));
      delete raw.resumen.totalGravada;
      readFileMock.mockResolvedValue(JSON.stringify(raw) as never);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(DteParseStatus.ERROR);
      expect(ledgerData().errorDetail).toContain('resumen.totalGravada');
    });

    it('archivo faltante en disco', async () => {
      const enoent = Object.assign(new Error('no existe'), { code: 'ENOENT' });
      statMock.mockRejectedValue(enoent);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.ARCHIVO_FALTANTE,
      );
    });

    it('ruta fuera del área del tenant se registra como ERROR y no se reintenta', async () => {
      storageMock.resolveSafe.mockImplementation(() => {
        throw new BadRequestException({ error: 'INVALID_STORAGE_PATH', message: 'fuera' });
      });

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(DteParseStatus.ERROR);
      expect(readFileMock).not.toHaveBeenCalled();
    });
  });

  describe('cap de tamaño', () => {
    it('rechaza por el tamaño de la fila sin tocar el disco', async () => {
      prismaMock.attachment.findFirst.mockResolvedValue(
        attachmentRow({ sizeBytes: MAX_JSON_BYTES + 1 }),
      );

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.ARCHIVO_DEMASIADO_GRANDE,
      );
      expect(storageMock.resolveSafe).not.toHaveBeenCalled();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('rechaza también si el archivo real creció respecto de la fila', async () => {
      statMock.mockResolvedValue({ size: MAX_JSON_BYTES + 1 } as Awaited<ReturnType<typeof stat>>);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBe(
        DteParseStatus.ARCHIVO_DEMASIADO_GRANDE,
      );
      expect(readFileMock).not.toHaveBeenCalled();
    });
  });

  describe('guardas de tenant y de adjunto', () => {
    it('no procesa nada si el tenant no existe', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue(null);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBeNull();
      expect(prismaMock.attachment.findFirst).not.toHaveBeenCalled();
    });

    it('no procesa nada si el tenant está suspendido', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue({ slug: 'x', status: 'SUSPENDIDO' });

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBeNull();
    });

    it('no procesa un adjunto que no pertenece al tenant', async () => {
      prismaMock.attachment.findFirst.mockResolvedValue(null);

      expect(await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).toBeNull();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('consulta el adjunto filtrando por tenantId y fileType JSON', async () => {
      await service.ingestAttachment(TENANT_ID, ATTACHMENT_ID);

      const where = (
        prismaMock.attachment.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }
      ).where;
      expect(where).toMatchObject({ id: ATTACHMENT_ID, tenantId: TENANT_ID, fileType: 'JSON' });
    });
  });

  describe('fallos de infraestructura: propagan para que la cola reintente', () => {
    it('un error de disco distinto de ENOENT se propaga', async () => {
      statMock.mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

      await expect(service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).rejects.toThrow('EIO');
    });

    it('un error de base de datos que no es violación única se propaga', async () => {
      prismaMock.purchaseDocument.create.mockRejectedValue(new Error('conexión perdida'));

      await expect(service.ingestAttachment(TENANT_ID, ATTACHMENT_ID)).rejects.toThrow(
        'conexión perdida',
      );
    });
  });
});
