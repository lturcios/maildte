import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PurchaseActivityService } from './purchase-activity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ListPurchaseActivitiesDto } from '../dto/list-purchase-activities.dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const RECEPTOR_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RECEPTOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EMISOR_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ACTIVITY_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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
  purchaseActivity: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  supplierActivityDefault: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  purchaseDocument: { count: jest.fn(), groupBy: jest.fn() },
  dteParty: { findFirst: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

function listDto(overrides: Partial<ListPurchaseActivitiesDto> = {}): ListPurchaseActivitiesDto {
  return Object.assign(
    new ListPurchaseActivitiesDto(),
    { receptorId: RECEPTOR_A, limit: 200 },
    overrides,
  );
}

function uniqueNameViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: ['tenantId', 'receptorId', 'nombre'] },
  });
}

/** Lo que devuelve Prisma cuando la fila desapareció antes de la escritura. */
function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found', {
    code: 'P2025',
    clientVersion: '5.22.0',
  });
}

/** Violación de una FK `ON DELETE RESTRICT` hacia `purchase_activities`. */
function foreignKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: '5.22.0',
    meta: { field_name: 'purchase_documents_activityId_fkey (index)' },
  });
}

describe('PurchaseActivityService', () => {
  let service: PurchaseActivityService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.purchaseActivity.findMany.mockResolvedValue([]);
    prismaMock.purchaseActivity.findFirst.mockResolvedValue({
      id: ACTIVITY_ID,
      receptorId: RECEPTOR_A,
      active: true,
    });
    prismaMock.purchaseActivity.create.mockResolvedValue({ id: ACTIVITY_ID });
    prismaMock.purchaseActivity.update.mockResolvedValue({
      id: ACTIVITY_ID,
      receptorId: RECEPTOR_A,
    });
    prismaMock.purchaseActivity.delete.mockResolvedValue({ id: ACTIVITY_ID });
    prismaMock.purchaseActivity.count.mockResolvedValue(0);
    prismaMock.supplierActivityDefault.findMany.mockResolvedValue([]);
    prismaMock.supplierActivityDefault.findFirst.mockResolvedValue({ id: 'map-1' });
    prismaMock.supplierActivityDefault.upsert.mockResolvedValue({ id: 'map-1' });
    prismaMock.supplierActivityDefault.count.mockResolvedValue(0);
    prismaMock.purchaseDocument.count.mockResolvedValue(0);
    prismaMock.purchaseDocument.groupBy.mockResolvedValue([]);
    prismaMock.dteParty.findFirst.mockResolvedValue({ id: RECEPTOR_A });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PurchaseActivityService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PurchaseActivityService);
  });

  describe('aislamiento por tenant y por receptor', () => {
    it('el listado filtra por tenant y por receptor a la vez', async () => {
      await service.findAll(adminCtx, listDto({ receptorId: RECEPTOR_A }));

      const args = prismaMock.purchaseActivity.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({ tenantId: TENANT_ID, receptorId: RECEPTOR_A });
      // El catálogo de otro contribuyente no puede colarse: el receptor es
      // parte del `where`, no un filtro opcional de pantalla.
      expect(args.where.receptorId).not.toBe(RECEPTOR_B);
    });

    it('la consulta corre siempre dentro de withTenant del tenant del contexto', async () => {
      await service.findAll(adminCtx, listDto());
      expect(prismaMock.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    });

    it('por defecto oculta las actividades desactivadas', async () => {
      await service.findAll(adminCtx, listDto());
      expect(prismaMock.purchaseActivity.findMany.mock.calls[0][0].where.active).toBe(true);
    });

    it('includeInactive muestra también las desactivadas', async () => {
      await service.findAll(adminCtx, listDto({ includeInactive: true }));
      expect(prismaMock.purchaseActivity.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'active',
      );
    });

    it('SUPERADMIN no accede al catálogo de un tenant', async () => {
      await expect(service.findAll(superadminCtx, listDto())).rejects.toThrow(ForbiddenException);
      expect(prismaMock.withTenant).not.toHaveBeenCalled();
    });

    it('404 si la actividad es de otro tenant', async () => {
      prismaMock.purchaseActivity.findFirst.mockResolvedValue(null);
      await expect(service.update(adminCtx, ACTIVITY_ID, { nombre: 'X' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaMock.purchaseActivity.update).not.toHaveBeenCalled();
    });

    it('la pertenencia se valida con id y tenantId a la vez', async () => {
      await service.update(adminCtx, ACTIVITY_ID, { nombre: 'X' });
      expect(prismaMock.purchaseActivity.findFirst.mock.calls[0][0].where).toEqual({
        id: ACTIVITY_ID,
        tenantId: TENANT_ID,
      });
    });
  });

  describe('identidad de la actividad', () => {
    /**
     * Decisión de diseño del addendum, no un descuido: dos locales del mismo
     * rubro son dos unidades de negocio con el mismo CIIU. El código es una
     * pista; la identidad es el nombre. Por eso no hay unique sobre
     * `codActividad` ni el servicio rechaza el duplicado.
     */
    it('permite dos actividades con el MISMO codActividad bajo el mismo receptor', async () => {
      await service.create(adminCtx, {
        receptorId: RECEPTOR_A,
        nombre: 'Restaurante Centro',
        codActividad: '56101',
      });
      await service.create(adminCtx, {
        receptorId: RECEPTOR_A,
        nombre: 'Restaurante Sur',
        codActividad: '56101',
      });

      expect(prismaMock.purchaseActivity.create).toHaveBeenCalledTimes(2);
      const [first, second] = prismaMock.purchaseActivity.create.mock.calls;
      expect(first[0].data.codActividad).toBe('56101');
      expect(second[0].data.codActividad).toBe('56101');
      expect(first[0].data.nombre).not.toBe(second[0].data.nombre);
    });

    it('rechaza dos actividades con el MISMO nombre bajo el mismo receptor', async () => {
      prismaMock.purchaseActivity.create.mockRejectedValue(uniqueNameViolation());

      await expect(
        service.create(adminCtx, { receptorId: RECEPTOR_A, nombre: 'Restaurante' }),
      ).rejects.toThrow(ConflictException);
    });

    it('también traduce el choque de nombre al renombrar', async () => {
      prismaMock.purchaseActivity.update.mockRejectedValue(uniqueNameViolation());

      await expect(
        service.update(adminCtx, ACTIVITY_ID, { nombre: 'Restaurante' }),
      ).rejects.toThrow(ConflictException);
    });

    it('no se puede crear una actividad para un receptor de otro tenant', async () => {
      prismaMock.dteParty.findFirst.mockResolvedValue(null);

      await expect(
        service.create(adminCtx, { receptorId: RECEPTOR_B, nombre: 'Ajena' }),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.purchaseActivity.create).not.toHaveBeenCalled();
    });
  });

  describe('retiro de una actividad', () => {
    it('desactiva en vez de borrar cuando el mapeo de proveedores la referencia', async () => {
      prismaMock.supplierActivityDefault.count.mockResolvedValue(3);

      await expect(service.remove(adminCtx, ACTIVITY_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prismaMock.purchaseActivity.delete).not.toHaveBeenCalled();

      // La salida es desactivarla: el mapeo sigue apuntando a algo que existe.
      await service.deactivate(adminCtx, ACTIVITY_ID);
      expect(prismaMock.purchaseActivity.update.mock.calls[0][0].data).toEqual({ active: false });
    });

    it('tampoco borra si un documento la tiene como override', async () => {
      prismaMock.purchaseDocument.count.mockResolvedValue(12);

      await expect(service.remove(adminCtx, ACTIVITY_ID)).rejects.toMatchObject({
        response: { error: 'PURCHASE_ACTIVITY_IN_USE' },
      });
      expect(prismaMock.purchaseActivity.delete).not.toHaveBeenCalled();
    });

    it('borra cuando nada la referencia', async () => {
      await expect(service.remove(adminCtx, ACTIVITY_ID)).resolves.toEqual({
        id: ACTIVITY_ID,
        deleted: true,
      });
      expect(prismaMock.purchaseActivity.delete).toHaveBeenCalledWith({
        where: { id: ACTIVITY_ID },
      });
    });
  });

  /**
   * Las tres operaciones comprueban la pertenencia y DESPUÉS escriben. Entre
   * las dos consultas cabe un borrado concurrente —dos pestañas del panel, una
   * petición reintentada— y Prisma responde P2025. Sin traducir, ese código
   * llega al filtro genérico como un 500 "Ocurrió un error interno inesperado";
   * el resultado correcto es el 404 que habría dado la comprobación un instante
   * después.
   */
  describe('carrera con un borrado concurrente', () => {
    it('update devuelve 404 y no un 500 si la actividad desapareció', async () => {
      prismaMock.purchaseActivity.update.mockRejectedValue(recordNotFound());

      await expect(service.update(adminCtx, ACTIVITY_ID, { nombre: 'X' })).rejects.toMatchObject({
        status: 404,
        response: { error: 'PURCHASE_ACTIVITY_NOT_FOUND' },
      });
    });

    it('deactivate devuelve 404 y no un 500 si la actividad desapareció', async () => {
      prismaMock.purchaseActivity.update.mockRejectedValue(recordNotFound());

      await expect(service.deactivate(adminCtx, ACTIVITY_ID)).rejects.toMatchObject({
        status: 404,
        response: { error: 'PURCHASE_ACTIVITY_NOT_FOUND' },
      });
    });

    it('remove devuelve 404 y no un 500 si la actividad desapareció', async () => {
      prismaMock.purchaseActivity.delete.mockRejectedValue(recordNotFound());

      await expect(service.remove(adminCtx, ACTIVITY_ID)).rejects.toMatchObject({
        status: 404,
        response: { error: 'PURCHASE_ACTIVITY_NOT_FOUND' },
      });
    });

    it('remove devuelve el 422 de siempre si la FK RESTRICT rechaza el borrado', async () => {
      // Algo empezó a referenciar la actividad DESPUÉS de los dos conteos: la
      // base la protege con ON DELETE RESTRICT y el usuario tiene que ver el
      // mismo mensaje que cuando los conteos la encuentran en uso.
      prismaMock.purchaseActivity.delete.mockRejectedValue(foreignKeyViolation());

      await expect(service.remove(adminCtx, ACTIVITY_ID)).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_ACTIVITY_IN_USE' },
      });
    });

    it('un error que no es de Prisma se propaga tal cual: no se disfraza de 404', async () => {
      const boom = new Error('conexión perdida');
      prismaMock.purchaseActivity.update.mockRejectedValue(boom);

      await expect(service.update(adminCtx, ACTIVITY_ID, { nombre: 'X' })).rejects.toBe(boom);
    });
  });

  describe('mapeo (proveedor, receptor) -> actividad', () => {
    it('rechaza un default que apunta a la actividad de OTRO receptor', async () => {
      prismaMock.purchaseActivity.findFirst.mockResolvedValue({
        id: ACTIVITY_ID,
        receptorId: RECEPTOR_B,
        active: true,
      });

      await expect(
        service.setSupplierDefault(adminCtx, {
          receptorId: RECEPTOR_A,
          emisorId: EMISOR_ID,
          activityId: ACTIVITY_ID,
        }),
      ).rejects.toMatchObject({
        response: { error: 'PURCHASE_ACTIVITY_RECEPTOR_MISMATCH' },
      });
      expect(prismaMock.supplierActivityDefault.upsert).not.toHaveBeenCalled();
    });

    it('rechaza un default que apunta a una actividad desactivada', async () => {
      prismaMock.purchaseActivity.findFirst.mockResolvedValue({
        id: ACTIVITY_ID,
        receptorId: RECEPTOR_A,
        active: false,
      });

      await expect(
        service.setSupplierDefault(adminCtx, {
          receptorId: RECEPTOR_A,
          emisorId: EMISOR_ID,
          activityId: ACTIVITY_ID,
        }),
      ).rejects.toMatchObject({ response: { error: 'PURCHASE_ACTIVITY_INACTIVE' } });
    });

    it('escribe el mapeo por la clave (tenant, receptor, emisor) y registra al actor', async () => {
      await service.setSupplierDefault(adminCtx, {
        receptorId: RECEPTOR_A,
        emisorId: EMISOR_ID,
        activityId: ACTIVITY_ID,
      });

      const args = prismaMock.supplierActivityDefault.upsert.mock.calls[0][0];
      expect(args.where.tenantId_receptorId_emisorId).toEqual({
        tenantId: TENANT_ID,
        receptorId: RECEPTOR_A,
        emisorId: EMISOR_ID,
      });
      expect(args.create.assignedById).toBe('user-1');
      expect(args.create.assignedAt).toBeInstanceOf(Date);
      expect(args.update.assignedById).toBe('user-1');
    });

    it('lista el mapeo ordenado por volumen de compras, no alfabéticamente', async () => {
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([
        { id: 'm1', emisorId: 'e-alfa', emisor: { id: 'e-alfa', nit: '1', nombre: 'ALFA' } },
        { id: 'm2', emisorId: 'e-zeta', emisor: { id: 'e-zeta', nit: '2', nombre: 'ZETA' } },
        { id: 'm3', emisorId: 'e-beta', emisor: { id: 'e-beta', nit: '3', nombre: 'BETA' } },
      ]);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { emisorId: 'e-alfa', _count: { _all: 3 } },
        { emisorId: 'e-zeta', _count: { _all: 400 } },
        { emisorId: 'e-beta', _count: { _all: 40 } },
      ]);

      const rows = await service.findSupplierDefaults(adminCtx, { receptorId: RECEPTOR_A });

      expect(rows.map((row) => row.emisorId)).toEqual(['e-zeta', 'e-beta', 'e-alfa']);
      expect(rows.map((row) => row.documentCount)).toEqual([400, 40, 3]);
    });

    /**
     * A igual volumen el orden no puede quedar a merced de lo que devuelva la
     * base: dos llamadas seguidas darían listas distintas y la pantalla de mapeo
     * saltaría de lugar entre recargas. Los dos casos de abajo son el empate
     * exacto, que es donde el desempate se ejerce.
     */
    it('a igual volumen desempata por nombre del proveedor', async () => {
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([
        { id: 'm1', emisorId: 'e-zeta', emisor: { id: 'e-zeta', nit: '1', nombre: 'ZETA' } },
        { id: 'm2', emisorId: 'e-alfa', emisor: { id: 'e-alfa', nit: '2', nombre: 'ALFA' } },
      ]);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { emisorId: 'e-zeta', _count: { _all: 40 } },
        { emisorId: 'e-alfa', _count: { _all: 40 } },
      ]);

      const rows = await service.findSupplierDefaults(adminCtx, { receptorId: RECEPTOR_A });

      expect(rows.map((row) => row.emisorId)).toEqual(['e-alfa', 'e-zeta']);
    });

    it('a igual volumen y mismo nombre desempata por id del proveedor', async () => {
      // Dos sucursales cargadas con el mismo nombre comercial: sin el tercer
      // criterio el orden dependería del plan de la consulta.
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([
        { id: 'm1', emisorId: 'e-bbb', emisor: { id: 'e-bbb', nit: '1', nombre: 'DISTRIBUIDORA' } },
        { id: 'm2', emisorId: 'e-aaa', emisor: { id: 'e-aaa', nit: '2', nombre: 'DISTRIBUIDORA' } },
      ]);
      prismaMock.purchaseDocument.groupBy.mockResolvedValue([
        { emisorId: 'e-bbb', _count: { _all: 7 } },
        { emisorId: 'e-aaa', _count: { _all: 7 } },
      ]);

      const rows = await service.findSupplierDefaults(adminCtx, { receptorId: RECEPTOR_A });

      expect(rows.map((row) => row.emisorId)).toEqual(['e-aaa', 'e-bbb']);
    });

    it('el volumen se cuenta solo contra las compras de ESE receptor', async () => {
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([
        { id: 'm1', emisorId: 'e-alfa', emisor: { id: 'e-alfa', nit: '1', nombre: 'ALFA' } },
      ]);

      await service.findSupplierDefaults(adminCtx, { receptorId: RECEPTOR_A });

      expect(prismaMock.purchaseDocument.groupBy.mock.calls[0][0].where).toMatchObject({
        tenantId: TENANT_ID,
        receptorId: RECEPTOR_A,
      });
    });

    it('404 al limpiar un mapeo que no existe', async () => {
      prismaMock.supplierActivityDefault.findFirst.mockResolvedValue(null);

      await expect(
        service.clearSupplierDefault(adminCtx, { receptorId: RECEPTOR_A, emisorId: EMISOR_ID }),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.supplierActivityDefault.delete).not.toHaveBeenCalled();
    });
  });
});
