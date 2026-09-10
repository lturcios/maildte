import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PurchaseActivitySeedService, SEED_MAX_GROUPS } from './purchase-activity-seed.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ApplyActivitySeedDto } from '../dto/activity-seed.dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const RECEPTOR_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMISOR_1 = 'e1111111-1111-1111-1111-111111111111';
const EMISOR_2 = 'e2222222-2222-2222-2222-222222222222';

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
  purchaseDocument: { groupBy: jest.fn(), count: jest.fn() },
  purchaseActivity: { findMany: jest.fn(), createMany: jest.fn() },
  supplierActivityDefault: { findMany: jest.fn(), createMany: jest.fn() },
  dteParty: { findFirst: jest.fn(), findMany: jest.fn() },
  withTenant: jest.fn(callWithTenantMock),
};

/**
 * Estado del catálogo del receptor a lo largo de `apply()`.
 *
 * `apply()` consulta el catálogo dos veces: antes de escribir, para saber qué
 * saltear, y después del `createMany`, para resolver nombre -> id (createMany
 * no devuelve ids). `after` por defecto es `before` más lo que se acaba de
 * insertar; se puede forzar para simular una corrida concurrente.
 */
function mockCatalog(before: { id: string; nombre: string }[], after = before): void {
  // `mockReset` y no `mockClear`: `jest.clearAllMocks()` NO vacía la cola de
  // `mockResolvedValueOnce`, así que sin esto las respuestas encoladas por un
  // test se le servirían al siguiente.
  prismaMock.purchaseActivity.findMany.mockReset();
  prismaMock.purchaseActivity.findMany
    .mockResolvedValueOnce(before)
    .mockResolvedValueOnce(after)
    .mockResolvedValue(after);
}

/**
 * Las tres agregaciones de `propose()` se resuelven en el mismo `Promise.all`
 * y en este orden: por código, por (proveedor, código) y por proveedor.
 */
function mockGroupBy(byCode: unknown[], bySupplierCode: unknown[], bySupplier: unknown[]): void {
  prismaMock.purchaseDocument.groupBy
    .mockResolvedValueOnce(byCode)
    .mockResolvedValueOnce(bySupplierCode)
    .mockResolvedValueOnce(bySupplier);
}

function applyDto(overrides: Partial<ApplyActivitySeedDto> = {}): ApplyActivitySeedDto {
  return Object.assign(
    new ApplyActivitySeedDto(),
    {
      receptorId: RECEPTOR_A,
      confirm: true,
      activities: [{ nombre: 'Restaurante', codActividad: '56101' }],
      mappings: [{ emisorId: EMISOR_1, activityNombre: 'Restaurante' }],
    },
    overrides,
  );
}

describe('PurchaseActivitySeedService', () => {
  let service: PurchaseActivitySeedService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.withTenant.mockImplementation(callWithTenantMock);
    prismaMock.purchaseDocument.groupBy.mockResolvedValue([]);
    prismaMock.purchaseDocument.count.mockResolvedValue(0);
    // Catálogo vacío al empezar; tras el createMany aparece la actividad que
    // este lote acaba de insertar, que es lo que resuelve el mapeo.
    mockCatalog([], [{ id: 'act-1', nombre: 'Restaurante' }]);
    prismaMock.purchaseActivity.createMany.mockImplementation(
      (args: { data: unknown[] }): Promise<{ count: number }> =>
        Promise.resolve({ count: args.data.length }),
    );
    prismaMock.supplierActivityDefault.findMany.mockResolvedValue([]);
    prismaMock.supplierActivityDefault.createMany.mockImplementation(
      (args: { data: unknown[] }): Promise<{ count: number }> =>
        Promise.resolve({ count: args.data.length }),
    );
    prismaMock.dteParty.findFirst.mockResolvedValue({ id: RECEPTOR_A });
    prismaMock.dteParty.findMany.mockResolvedValue([{ id: EMISOR_1 }, { id: EMISOR_2 }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PurchaseActivitySeedService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PurchaseActivitySeedService);
  });

  describe('propose', () => {
    it('no escribe nada: la propuesta es solo lectura', async () => {
      await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(prismaMock.purchaseActivity.createMany).not.toHaveBeenCalled();
      expect(prismaMock.supplierActivityDefault.createMany).not.toHaveBeenCalled();
    });

    it('SUPERADMIN no siembra el catálogo de un tenant', async () => {
      await expect(service.propose(superadminCtx, { receptorId: RECEPTOR_A })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404 si el receptor no es del tenant', async () => {
      prismaMock.dteParty.findFirst.mockResolvedValue(null);
      await expect(service.propose(adminCtx, { receptorId: RECEPTOR_A })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('propone una actividad por código distinto, con la descripción del DTE', async () => {
      mockGroupBy(
        [
          {
            receptorCodActividad: '56101',
            receptorDescActividad: 'RESTAURANTES',
            _count: { _all: 800 },
          },
          {
            receptorCodActividad: '10005',
            receptorDescActividad: 'Otros',
            _count: { _all: 10 },
          },
        ],
        [],
        [],
      );

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.activities).toEqual([
        { codActividad: '56101', nombre: 'RESTAURANTES', documentCount: 800 },
        { codActividad: '10005', nombre: 'Otros', documentCount: 10 },
      ]);
    });

    it('con dos descripciones para el mismo código gana la más frecuente', async () => {
      mockGroupBy(
        [
          { receptorCodActividad: '56101', receptorDescActividad: 'Rara', _count: { _all: 2 } },
          {
            receptorCodActividad: '56101',
            receptorDescActividad: 'RESTAURANTES',
            _count: { _all: 90 },
          },
        ],
        [],
        [],
      );

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.activities).toEqual([
        { codActividad: '56101', nombre: 'RESTAURANTES', documentCount: 92 },
      ]);
    });

    it('a igual frecuencia de descripción gana la alfabéticamente menor (desempate)', async () => {
      mockGroupBy(
        [
          { receptorCodActividad: '56101', receptorDescActividad: 'Zeta', _count: { _all: 5 } },
          { receptorCodActividad: '56101', receptorDescActividad: 'Alfa', _count: { _all: 5 } },
        ],
        [],
        [],
      );

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.activities[0].nombre).toBe('Alfa');
    });

    it('sin descripción el nombre propuesto es el propio código: no se inventa texto', async () => {
      mockGroupBy(
        [{ receptorCodActividad: '56101', receptorDescActividad: null, _count: { _all: 4 } }],
        [],
        [],
      );

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.activities[0].nombre).toBe('56101');
    });

    it('mapea cada proveedor al código que declara con MÁS frecuencia', async () => {
      mockGroupBy(
        [
          {
            receptorCodActividad: '56101',
            receptorDescActividad: 'RESTAURANTES',
            _count: { _all: 30 },
          },
          {
            receptorCodActividad: '47190',
            receptorDescActividad: 'PANADERIA',
            _count: { _all: 5 },
          },
        ],
        [
          { emisorId: EMISOR_1, receptorCodActividad: '47190', _count: { _all: 4 } },
          { emisorId: EMISOR_1, receptorCodActividad: '56101', _count: { _all: 26 } },
        ],
        [{ emisorId: EMISOR_1, _count: { _all: 30 } }],
      );
      prismaMock.dteParty.findMany.mockResolvedValue([
        { id: EMISOR_1, nit: '0614', nombre: 'DISTRIBUIDORA' },
      ]);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.mappings).toEqual([
        {
          emisorId: EMISOR_1,
          emisorNit: '0614',
          emisorNombre: 'DISTRIBUIDORA',
          codActividad: '56101',
          activityNombre: 'RESTAURANTES',
          documentCount: 30,
          matchingCount: 26,
        },
      ]);
    });

    it('empate de códigos en un proveedor: gana el código lexicográficamente menor', async () => {
      mockGroupBy(
        [
          { receptorCodActividad: '56101', receptorDescActividad: 'A', _count: { _all: 7 } },
          { receptorCodActividad: '47190', receptorDescActividad: 'B', _count: { _all: 7 } },
        ],
        [
          { emisorId: EMISOR_1, receptorCodActividad: '56101', _count: { _all: 7 } },
          { emisorId: EMISOR_1, receptorCodActividad: '47190', _count: { _all: 7 } },
        ],
        [{ emisorId: EMISOR_1, _count: { _all: 14 } }],
      );
      prismaMock.dteParty.findMany.mockResolvedValue([
        { id: EMISOR_1, nit: '0614', nombre: 'DISTRIBUIDORA' },
      ]);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.mappings[0].codActividad).toBe('47190');
    });

    it('ordena los mapeos por volumen de compras del proveedor', async () => {
      mockGroupBy(
        [{ receptorCodActividad: '56101', receptorDescActividad: 'A', _count: { _all: 100 } }],
        [
          { emisorId: EMISOR_1, receptorCodActividad: '56101', _count: { _all: 3 } },
          { emisorId: EMISOR_2, receptorCodActividad: '56101', _count: { _all: 97 } },
        ],
        [
          { emisorId: EMISOR_1, _count: { _all: 3 } },
          { emisorId: EMISOR_2, _count: { _all: 97 } },
        ],
      );
      prismaMock.dteParty.findMany.mockResolvedValue([
        { id: EMISOR_1, nit: '1', nombre: 'AAA' },
        { id: EMISOR_2, nit: '2', nombre: 'ZZZ' },
      ]);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.mappings.map((row) => row.emisorId)).toEqual([EMISOR_2, EMISOR_1]);
    });

    /**
     * A igual volumen el orden de los mapeos no puede depender de lo que
     * devuelva la base: la propuesta se revisa a mano y dos corridas sobre los
     * mismos datos tienen que ofrecer la misma lista. Los tests de arriba usan
     * volúmenes distintos, así que el desempate nunca se ejercía.
     */
    it('a igual volumen los mapeos desempatan por nombre del proveedor', async () => {
      mockGroupBy(
        [{ receptorCodActividad: '56101', receptorDescActividad: 'A', _count: { _all: 20 } }],
        [
          { emisorId: EMISOR_1, receptorCodActividad: '56101', _count: { _all: 10 } },
          { emisorId: EMISOR_2, receptorCodActividad: '56101', _count: { _all: 10 } },
        ],
        [
          { emisorId: EMISOR_1, _count: { _all: 10 } },
          { emisorId: EMISOR_2, _count: { _all: 10 } },
        ],
      );
      prismaMock.dteParty.findMany.mockResolvedValue([
        { id: EMISOR_1, nit: '1', nombre: 'ZZZ' },
        { id: EMISOR_2, nit: '2', nombre: 'AAA' },
      ]);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      expect(proposal.mappings.map((row) => row.emisorId)).toEqual([EMISOR_2, EMISOR_1]);
    });

    it('a igual volumen y mismo nombre los mapeos desempatan por id', async () => {
      mockGroupBy(
        [{ receptorCodActividad: '56101', receptorDescActividad: 'A', _count: { _all: 20 } }],
        [
          { emisorId: EMISOR_2, receptorCodActividad: '56101', _count: { _all: 10 } },
          { emisorId: EMISOR_1, receptorCodActividad: '56101', _count: { _all: 10 } },
        ],
        [
          { emisorId: EMISOR_2, _count: { _all: 10 } },
          { emisorId: EMISOR_1, _count: { _all: 10 } },
        ],
      );
      prismaMock.dteParty.findMany.mockResolvedValue([
        { id: EMISOR_1, nit: '1', nombre: 'DISTRIBUIDORA' },
        { id: EMISOR_2, nit: '2', nombre: 'DISTRIBUIDORA' },
      ]);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });

      // EMISOR_1 empieza con 'e1' y EMISOR_2 con 'e2': el menor va primero
      // aunque la agregación los haya devuelto al revés.
      expect(proposal.mappings.map((row) => row.emisorId)).toEqual([EMISOR_1, EMISOR_2]);
    });

    it('informa cuántas compras no traen actividad en el DTE', async () => {
      prismaMock.purchaseDocument.count.mockResolvedValue(17);
      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });
      expect(proposal.documentsWithoutActivity).toBe(17);
    });

    /**
     * Recortar la agregación por encima del tope daría un "código más
     * frecuente" calculado sobre una muestra arbitraria: una propuesta
     * silenciosamente equivocada. El 422 dice que la siembra no aplica a ese
     * volumen y manda a la clasificación masiva.
     */
    it('422 si el histórico supera el tope de combinaciones por código', async () => {
      const groups = Array.from({ length: SEED_MAX_GROUPS + 1 }, (_, i) => ({
        receptorCodActividad: String(10000 + i),
        receptorDescActividad: `Actividad ${i}`,
        _count: { _all: 1 },
      }));
      mockGroupBy(groups, [], []);

      await expect(service.propose(adminCtx, { receptorId: RECEPTOR_A })).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_BOOK_SEED_TOO_LARGE' },
      });
    });

    it('422 también si el que supera el tope es el cruce proveedor x código', async () => {
      const groups = Array.from({ length: SEED_MAX_GROUPS + 1 }, (_, i) => ({
        emisorId: `emisor-${i}`,
        receptorCodActividad: '56101',
        _count: { _all: 1 },
      }));
      mockGroupBy([], groups, []);

      await expect(service.propose(adminCtx, { receptorId: RECEPTOR_A })).rejects.toMatchObject({
        status: 422,
        response: { error: 'PURCHASE_BOOK_SEED_TOO_LARGE' },
      });
    });

    it('el tope exacto NO se rechaza: el límite es inclusivo', async () => {
      const groups = Array.from({ length: SEED_MAX_GROUPS }, (_, i) => ({
        receptorCodActividad: String(10000 + i),
        receptorDescActividad: `Actividad ${i}`,
        _count: { _all: 1 },
      }));
      mockGroupBy(groups, [], []);

      const proposal = await service.propose(adminCtx, { receptorId: RECEPTOR_A });
      expect(proposal.activities).toHaveLength(SEED_MAX_GROUPS);
    });
  });

  describe('apply', () => {
    it('crea catálogo y mapeo en la primera corrida', async () => {
      const result = await service.apply(adminCtx, applyDto());

      expect(result).toMatchObject({
        activitiesCreated: 1,
        activitiesSkipped: 0,
        mappingsCreated: 1,
        mappingsSkipped: 0,
      });
      expect(prismaMock.purchaseActivity.createMany.mock.calls[0][0].data[0]).toMatchObject({
        tenantId: TENANT_ID,
        receptorId: RECEPTOR_A,
        nombre: 'Restaurante',
        codActividad: '56101',
      });
      expect(prismaMock.supplierActivityDefault.createMany.mock.calls[0][0].data[0]).toMatchObject({
        tenantId: TENANT_ID,
        receptorId: RECEPTOR_A,
        emisorId: EMISOR_1,
        activityId: 'act-1',
        assignedById: 'user-1',
      });
    });

    /**
     * El lote llega a 200 actividades + 1000 mapeos y `withTenant()` no cambia
     * el timeout de 5 s de una transacción interactiva de Prisma. Con un
     * `create` por fila eran 1200 idas y vueltas dentro de esa transacción: en
     * la base del VPS, un 500 sin traducir. Se afirma el NÚMERO de escrituras,
     * no solo el resultado, porque es lo que se rompería en una regresión.
     */
    it('escribe el lote en dos INSERT y no en una escritura por fila', async () => {
      mockCatalog(
        [],
        [
          { id: 'act-1', nombre: 'Restaurante' },
          { id: 'act-2', nombre: 'Panadería' },
        ],
      );

      const result = await service.apply(
        adminCtx,
        applyDto({
          activities: [{ nombre: 'Restaurante' }, { nombre: 'Panadería' }],
          mappings: [
            { emisorId: EMISOR_1, activityNombre: 'Restaurante' },
            { emisorId: EMISOR_2, activityNombre: 'Panadería' },
          ],
        }),
      );
      // El catálogo relee incluye las dos, para resolver nombre -> id.
      expect(result.activitiesCreated).toBe(2);
      expect(prismaMock.purchaseActivity.createMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.supplierActivityDefault.createMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.purchaseActivity.createMany.mock.calls[0][0].data).toHaveLength(2);
      expect(prismaMock.supplierActivityDefault.createMany.mock.calls[0][0].data).toHaveLength(2);
    });

    it('los dos INSERT van con skipDuplicates: la idempotencia la garantiza la base', async () => {
      await service.apply(adminCtx, applyDto());

      expect(prismaMock.purchaseActivity.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
      expect(prismaMock.supplierActivityDefault.createMany.mock.calls[0][0].skipDuplicates).toBe(
        true,
      );
    });

    it('la segunda corrida es idempotente: no duplica ni actividades ni mapeos', async () => {
      // Estado tras la primera corrida.
      mockCatalog([{ id: 'act-1', nombre: 'Restaurante' }]);
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([{ emisorId: EMISOR_1 }]);

      const result = await service.apply(adminCtx, applyDto());

      expect(result).toMatchObject({
        activitiesCreated: 0,
        activitiesSkipped: 1,
        mappingsCreated: 0,
        mappingsSkipped: 1,
        skippedActivityNames: ['Restaurante'],
        skippedEmisorIds: [EMISOR_1],
      });
      expect(prismaMock.purchaseActivity.createMany).not.toHaveBeenCalled();
      expect(prismaMock.supplierActivityDefault.createMany).not.toHaveBeenCalled();
    });

    /**
     * Dos `apply()` a la vez —doble clic, petición reintentada, dos pestañas—.
     * Antes esto era un "consultar y después escribir": el segundo veía el
     * catálogo vacío, intentaba el `create` y se estrellaba con un P2002 crudo
     * que revertía el lote entero y salía como 500. Con `skipDuplicates` la
     * base descarta la fila repetida, el lote se completa y el mapeo resuelve
     * su actividad contra la fila que insertó el otro.
     */
    it('un apply() concurrente no rompe el lote ni duplica filas', async () => {
      // El catálogo estaba vacío al consultar, pero la actividad ya existía al
      // insertar: createMany informa 0 insertadas y la relectura la encuentra.
      mockCatalog([], [{ id: 'act-concurrente', nombre: 'Restaurante' }]);
      prismaMock.purchaseActivity.createMany.mockResolvedValue({ count: 0 });
      prismaMock.supplierActivityDefault.createMany.mockResolvedValue({ count: 0 });

      const result = await service.apply(adminCtx, applyDto());

      expect(result).toMatchObject({
        activitiesCreated: 0,
        activitiesSkipped: 1,
        mappingsCreated: 0,
        mappingsSkipped: 1,
      });
      // El mapeo apuntó a la fila del otro apply(), no quedó sin actividad.
      expect(prismaMock.supplierActivityDefault.createMany.mock.calls[0][0].data[0]).toMatchObject({
        activityId: 'act-concurrente',
      });
    });

    it('no pisa el mapeo que el contador ya corrigió a mano', async () => {
      mockCatalog([
        { id: 'act-1', nombre: 'Restaurante' },
        { id: 'act-2', nombre: 'Panadería' },
      ]);
      prismaMock.supplierActivityDefault.findMany.mockResolvedValue([{ emisorId: EMISOR_1 }]);

      const result = await service.apply(
        adminCtx,
        applyDto({ mappings: [{ emisorId: EMISOR_1, activityNombre: 'Panadería' }] }),
      );

      expect(result.mappingsCreated).toBe(0);
      expect(prismaMock.supplierActivityDefault.createMany).not.toHaveBeenCalled();
    });

    it('todo el lote va dentro de una sola transacción con tenant', async () => {
      await service.apply(adminCtx, applyDto());
      expect(prismaMock.withTenant).toHaveBeenCalledTimes(1);
      expect(prismaMock.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    });

    it('rechaza un mapeo que apunta a una actividad ausente de la propuesta', async () => {
      await expect(
        service.apply(
          adminCtx,
          applyDto({ mappings: [{ emisorId: EMISOR_1, activityNombre: 'Inexistente' }] }),
        ),
      ).rejects.toMatchObject({
        response: { error: 'PURCHASE_BOOK_SEED_UNKNOWN_ACTIVITY' },
      });
    });

    it('rechaza dos actividades con el mismo nombre en el mismo lote', async () => {
      await expect(
        service.apply(
          adminCtx,
          applyDto({
            activities: [{ nombre: 'Restaurante' }, { nombre: 'Restaurante' }],
            mappings: [],
          }),
        ),
      ).rejects.toMatchObject({
        response: { error: 'PURCHASE_BOOK_SEED_DUPLICATE_ACTIVITY' },
      });
      expect(prismaMock.withTenant).not.toHaveBeenCalled();
    });

    it('rechaza dos mapeos para el mismo proveedor en el mismo lote', async () => {
      await expect(
        service.apply(
          adminCtx,
          applyDto({
            mappings: [
              { emisorId: EMISOR_1, activityNombre: 'Restaurante' },
              { emisorId: EMISOR_1, activityNombre: 'Restaurante' },
            ],
          }),
        ),
      ).rejects.toMatchObject({
        response: { error: 'PURCHASE_BOOK_SEED_DUPLICATE_SUPPLIER' },
      });
    });

    it('rechaza un proveedor que no existe en el tenant', async () => {
      prismaMock.dteParty.findMany.mockResolvedValue([]);

      await expect(service.apply(adminCtx, applyDto())).rejects.toThrow(NotFoundException);
    });

    it('404 si el receptor no es del tenant', async () => {
      prismaMock.dteParty.findFirst.mockResolvedValue(null);

      await expect(service.apply(adminCtx, applyDto())).rejects.toThrow(NotFoundException);
      expect(prismaMock.purchaseActivity.createMany).not.toHaveBeenCalled();
    });
  });
});
