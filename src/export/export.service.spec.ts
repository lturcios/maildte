import { Test } from '@nestjs/testing';
import { ExportService } from './export.service';
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
