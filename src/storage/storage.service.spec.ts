import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { StorageService } from './storage.service';
import { AppConfigService } from '../config/app-config.service';

const TENANT_SLUG = 'acme';

describe('StorageService', () => {
  let storageRoot: string;
  let service: StorageService;

  const account = { folderName: 'compras_ltsoft_us' };
  const monthFolder = '2026-08';

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'maildte-storage-'));

    const configMock = { storageRoot, tzFolder: 'America/El_Salvador' };
    const loggerMock = { setContext: jest.fn(), error: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: AppConfigService, useValue: configMock },
        { provide: PinoLogger, useValue: loggerMock },
      ],
    }).compile();

    service = moduleRef.get(StorageService);
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe('resolveMonthFolder', () => {
    it('borde de mes: 2026-09-01T03:00:00Z (21:00 del 31/08 en El Salvador) -> "2026-08"', () => {
      expect(service.resolveMonthFolder(new Date('2026-09-01T03:00:00Z'))).toBe('2026-08');
    });

    it('cambio de año: 2027-01-01T04:00:00Z -> "2026-12"', () => {
      expect(service.resolveMonthFolder(new Date('2027-01-01T04:00:00Z'))).toBe('2026-12');
    });
  });

  describe('resolveSafe', () => {
    it('resuelve una ruta relativa dentro de STORAGE_ROOT/{tenantSlug}', () => {
      const resolved = service.resolveSafe(
        TENANT_SLUG,
        `${TENANT_SLUG}/compras_ltsoft_us/2026-08/pdf`,
      );
      expect(resolved.startsWith(join(storageRoot, TENANT_SLUG))).toBe(true);
    });

    it('lanza ante un intento de path traversal', () => {
      const escape = Array(10).fill('..').join('/') + '/etc/passwd';
      expect(() => service.resolveSafe(TENANT_SLUG, escape)).toThrow();
    });

    it('lanza ante un relativePath que pertenece al slug de OTRO tenant, aunque esté dentro de STORAGE_ROOT', () => {
      expect(() =>
        service.resolveSafe(TENANT_SLUG, 'otro-tenant/cuenta/2026-08/pdf/factura.pdf'),
      ).toThrow();
    });
  });

  describe('saveAttachment', () => {
    it('guarda un adjunto nuevo con escritura atómica (sin .tmp remanente)', async () => {
      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('contenido-factura'),
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });

      expect(result.reused).toBe(false);
      expect(result.relativePath).toBe(`${TENANT_SLUG}/compras_ltsoft_us/2026-08/pdf/factura.pdf`);
      expect(result.sizeBytes).toBe(Buffer.byteLength('contenido-factura'));

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = await readdir(dir);
      expect(files).toEqual(['factura.pdf']);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('coloca los adjuntos JSON en la subcarpeta json/ por extensión', async () => {
      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('{}'),
        account,
        monthFolder,
        originalName: 'documento.json',
        mimeType: 'application/octet-stream',
      });

      expect(result.relativePath).toBe(
        `${TENANT_SLUG}/compras_ltsoft_us/2026-08/json/documento.json`,
      );
    });

    it('usa la subcarpeta json/ por mimeType cuando el nombre no termina en .json (criterio OR)', async () => {
      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('{}'),
        account,
        monthFolder,
        originalName: 'documento.bin',
        mimeType: 'application/json',
      });

      expect(result.relativePath).toBe(
        `${TENANT_SLUG}/compras_ltsoft_us/2026-08/json/documento.bin`,
      );
    });

    it('colisión mismo nombre + mismo sha256 -> reused: true, un solo archivo en disco', async () => {
      const content = Buffer.from('contenido-idéntico');
      const first = await service.saveAttachment(TENANT_SLUG, {
        content,
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      const second = await service.saveAttachment(TENANT_SLUG, {
        content,
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.sha256).toBe(first.sha256);
      expect(second.storedName).toBe('factura.pdf');

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = await readdir(dir);
      expect(files).toEqual(['factura.pdf']);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('colisión mismo nombre + distinto sha256 -> sufijo _{8 chars del sha256}', async () => {
      const first = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('contenido-A'),
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      const second = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('contenido-B, distinto'),
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });

      expect(second.reused).toBe(false);
      expect(second.storedName).toBe(`factura_${second.sha256.slice(0, 8)}.pdf`);
      expect(second.storedName).not.toBe(first.storedName);

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = (await readdir(dir)).sort();
      expect(files).toEqual(['factura.pdf', second.storedName].sort());
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('reintentar la misma colisión ya resuelta también retorna reused: true (sin duplicar)', async () => {
      await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('contenido-A'),
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      const contentB = Buffer.from('contenido-B, distinto');
      const second = await service.saveAttachment(TENANT_SLUG, {
        content: contentB,
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      const third = await service.saveAttachment(TENANT_SLUG, {
        content: contentB,
        account,
        monthFolder,
        originalName: 'factura.pdf',
        mimeType: 'application/pdf',
      });

      expect(third.reused).toBe(true);
      expect(third.storedName).toBe(second.storedName);

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = await readdir(dir);
      expect(files).toHaveLength(2); // factura.pdf + factura_{hash}.pdf, sin triplicar
    });

    it('sanitiza el nombre y neutraliza path traversal preservando la extensión', async () => {
      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('x'),
        account,
        monthFolder,
        originalName: '../../etc/passwd.json',
        mimeType: 'application/json',
      });

      expect(result.storedName).not.toContain('..');
      expect(result.storedName).not.toContain('/');
      expect(result.storedName.endsWith('.json')).toBe(true);
    });

    it('trunca nombres mayores a 180 caracteres conservando la extensión', async () => {
      const longName = 'a'.repeat(250) + '.pdf';

      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('x'),
        account,
        monthFolder,
        originalName: longName,
        mimeType: 'application/pdf',
      });

      expect(result.storedName.length).toBe(180);
      expect(result.storedName.endsWith('.pdf')).toBe(true);
    });

    it('hashea y escribe por streaming cuando content es un Readable (adjuntos grandes)', async () => {
      const payload = Buffer.from('x'.repeat(1024));
      const stream = Readable.from([payload.subarray(0, 512), payload.subarray(512)]);

      const result = await service.saveAttachment(TENANT_SLUG, {
        content: stream,
        account,
        monthFolder,
        originalName: 'grande.pdf',
        mimeType: 'application/pdf',
      });

      expect(result.sizeBytes).toBe(1024);
      expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = await readdir(dir);
      expect(files).toEqual(['grande.pdf']);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('cleanOrphanTmp', () => {
    it('borra archivos .tmp huérfanos en cualquier nivel de la carpeta de la cuenta', async () => {
      const accountDir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      await mkdir(accountDir, { recursive: true });
      await writeFile(join(accountDir, 'huerfano.pdf.tmp'), 'restos');
      await writeFile(join(accountDir, 'real.pdf'), 'contenido');

      await service.cleanOrphanTmp(TENANT_SLUG, 'compras_ltsoft_us');

      const files = await readdir(accountDir);
      expect(files).toEqual(['real.pdf']);
    });

    it('no lanza si la carpeta de la cuenta todavía no existe', async () => {
      await expect(
        service.cleanOrphanTmp(TENANT_SLUG, 'cuenta_inexistente'),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteFiles', () => {
    it('borra los archivos indicados', async () => {
      const result = await service.saveAttachment(TENANT_SLUG, {
        content: Buffer.from('x'),
        account,
        monthFolder,
        originalName: 'a.pdf',
        mimeType: 'application/pdf',
      });

      await service.deleteFiles(TENANT_SLUG, [result.relativePath]);

      const dir = join(storageRoot, TENANT_SLUG, 'compras_ltsoft_us', '2026-08', 'pdf');
      const files = await readdir(dir);
      expect(files).toEqual([]);
    });

    it('ignora archivos que ya no existen (ENOENT) sin lanzar', async () => {
      await expect(
        service.deleteFiles(TENANT_SLUG, [
          `${TENANT_SLUG}/compras_ltsoft_us/2026-08/pdf/no-existe.pdf`,
        ]),
      ).resolves.toBeUndefined();
    });
  });
});
