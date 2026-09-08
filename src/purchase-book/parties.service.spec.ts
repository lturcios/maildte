import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PartiesService } from './parties.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ListPartiesDto } from './dto/list-parties.dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

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

function callWithTenantMock(_tenantId: string, fn: (tx: unknown) => unknown): unknown {
  return fn(prismaMock);
}

const prismaMock = {
  dteParty: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

function partiesDto(overrides: Partial<ListPartiesDto> = {}): ListPartiesDto {
  return Object.assign(new ListPartiesDto(), { role: 'EMISOR', limit: 200 }, overrides);
}

describe('PartiesService', () => {
  let service: PartiesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.dteParty.findMany.mockResolvedValue([]);
    prismaMock.dteParty.findFirst.mockResolvedValue({ id: 'party-1' });
    prismaMock.dteParty.update.mockResolvedValue({ id: 'party-1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartiesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PartiesService);
  });

  describe('findAll', () => {
    it('filtra por el rol de emisor', async () => {
      await service.findAll(adminCtx, partiesDto({ role: 'EMISOR' }));
      const where = prismaMock.dteParty.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT_ID, seenAsEmisor: true });
      expect(where).not.toHaveProperty('seenAsReceptor');
    });

    it('filtra por el rol de receptor', async () => {
      await service.findAll(adminCtx, partiesDto({ role: 'RECEPTOR' }));
      const where = prismaMock.dteParty.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT_ID, seenAsReceptor: true });
    });

    it('busca por nombre, nombre comercial e identificador', async () => {
      await service.findAll(adminCtx, partiesDto({ q: 'ltsoft' }));
      const where = prismaMock.dteParty.findMany.mock.calls[0][0].where;
      expect(where.OR).toHaveLength(3);
    });

    it('ordena por nombre y respeta el límite', async () => {
      await service.findAll(adminCtx, partiesDto({ limit: 50 }));
      const args = prismaMock.dteParty.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ nombre: 'asc' });
      expect(args.take).toBe(50);
    });

    it('incluye el conteo de documentos por rol', async () => {
      await service.findAll(adminCtx, partiesDto());
      const select = prismaMock.dteParty.findMany.mock.calls[0][0].select;
      expect(select._count).toEqual({
        select: { emisorDocuments: true, receptorDocuments: true },
      });
    });

    it('SUPERADMIN no accede al catálogo de un tenant', async () => {
      await expect(service.findAll(superadminCtx, partiesDto())).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('updateDefaults', () => {
    it('escribe los defaults presentes en el body', async () => {
      await service.updateDefaults(adminCtx, 'party-1', {
        defaultClasificacion: 2,
        defaultSector: 4,
      });

      const data = prismaMock.dteParty.update.mock.calls[0][0].data;
      expect(data).toEqual({ defaultClasificacion: 2, defaultSector: 4 });
    });

    it('un null explícito limpia el default', async () => {
      await service.updateDefaults(adminCtx, 'party-1', { defaultSector: null });
      expect(prismaMock.dteParty.update.mock.calls[0][0].data.defaultSector).toBeNull();
    });

    it('no toca los defaults ausentes del body', async () => {
      await service.updateDefaults(adminCtx, 'party-1', { defaultSector: 1 });
      const data = prismaMock.dteParty.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('defaultTipoOperacion');
    });

    it('404 si la parte es de otro tenant', async () => {
      prismaMock.dteParty.findFirst.mockResolvedValue(null);
      await expect(service.updateDefaults(adminCtx, 'ajena', { defaultSector: 1 })).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaMock.dteParty.update).not.toHaveBeenCalled();
    });

    it('valida la pertenencia con id y tenantId a la vez', async () => {
      await service.updateDefaults(adminCtx, 'party-1', { defaultSector: 1 });
      expect(prismaMock.dteParty.findFirst.mock.calls[0][0].where).toEqual({
        id: 'party-1',
        tenantId: TENANT_ID,
      });
    });
  });
});
