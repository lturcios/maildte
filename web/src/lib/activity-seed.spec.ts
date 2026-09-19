import { buildSeedPayload, canMerge, resolveSurvivor, toDraft } from './activity-seed';
import type { SeedDraftActivity } from './activity-seed';
import type { ProposedSupplierMapping } from '@/types/domain';

const RECEPTOR = '22222222-2222-2222-2222-222222222222';

/**
 * El caso real que motivó la fase 3: un solo restaurante partido en cuatro
 * códigos porque cada proveedor eligió una etiqueta distinta.
 */
function propuestaReal(): SeedDraftActivity[] {
  return [
    { codActividad: '56101', nombre: 'RESTAURANTES', documentCount: 561 },
    { codActividad: '56107', nombre: 'Actividades varias de restaurantes', documentCount: 290 },
    { codActividad: '47219', nombre: 'Venta al por menor de alimentos n.c.p.', documentCount: 8 },
    { codActividad: '10005', nombre: 'Otros', documentCount: 3 },
  ].map((row) => toDraft({ ...row }));
}

function mapping(
  emisorId: string,
  codActividad: string,
  overrides: Partial<ProposedSupplierMapping> = {},
): ProposedSupplierMapping {
  return {
    emisorId,
    emisorNit: `nit-${emisorId}`,
    emisorNombre: `Proveedor ${emisorId}`,
    codActividad,
    activityNombre: 'irrelevante: lo decide el borrador',
    documentCount: 10,
    matchingCount: 10,
    ...overrides,
  };
}

function merge(drafts: SeedDraftActivity[], source: string, target: string): SeedDraftActivity[] {
  return drafts.map((draft) =>
    draft.codActividad === source ? { ...draft, mergedInto: target } : draft,
  );
}

function discard(drafts: SeedDraftActivity[], code: string): SeedDraftActivity[] {
  return drafts.map((draft) =>
    draft.codActividad === code ? { ...draft, discarded: true } : draft,
  );
}

describe('resolveSurvivor', () => {
  it('una actividad sin fusionar sobrevive a sí misma', () => {
    expect(resolveSurvivor(propuestaReal(), '56101')?.codActividad).toBe('56101');
  });

  it('una fusionada resuelve a la que la absorbe', () => {
    const drafts = merge(propuestaReal(), '56107', '56101');
    expect(resolveSurvivor(drafts, '56107')?.codActividad).toBe('56101');
  });

  it('sigue la cadena completa: A fusionada en B, B fusionada en C', () => {
    let drafts = merge(propuestaReal(), '47219', '56107');
    drafts = merge(drafts, '56107', '56101');
    expect(resolveSurvivor(drafts, '47219')?.codActividad).toBe('56101');
  });

  it('una descartada no sobrevive', () => {
    expect(resolveSurvivor(discard(propuestaReal(), '10005'), '10005')).toBeNull();
  });

  it('fusionar en una descartada tampoco sobrevive', () => {
    const drafts = discard(merge(propuestaReal(), '47219', '10005'), '10005');
    expect(resolveSurvivor(drafts, '47219')).toBeNull();
  });

  it('un ciclo devuelve null en vez de colgarse', () => {
    let drafts = merge(propuestaReal(), '56101', '56107');
    drafts = merge(drafts, '56107', '56101');
    expect(resolveSurvivor(drafts, '56101')).toBeNull();
  });
});

describe('canMerge', () => {
  it('no se puede fusionar una actividad consigo misma', () => {
    expect(canMerge(propuestaReal(), '56101', '56101')).toBe(false);
  });

  it('permite la fusión normal', () => {
    expect(canMerge(propuestaReal(), '56107', '56101')).toBe(true);
  });

  it('rechaza la fusión que cerraría un ciclo', () => {
    // 56107 ya está dentro de 56101: meter 56101 dentro de 56107 sería un lazo.
    const drafts = merge(propuestaReal(), '56107', '56101');
    expect(canMerge(drafts, '56101', '56107')).toBe(false);
  });
});

describe('buildSeedPayload', () => {
  it('el caso del addendum: fusionar 56107 en 56101 y descartar "Otros"', () => {
    let drafts = merge(propuestaReal(), '56107', '56101');
    drafts = discard(drafts, '10005');

    const mappings = [
      mapping('e-1', '56101'),
      mapping('e-2', '56107'),
      mapping('e-3', '47219'),
      mapping('e-4', '10005'),
    ];

    const { payload, droppedMappings } = buildSeedPayload(RECEPTOR, drafts, mappings);

    // Quedan dos actividades: el restaurante unificado y la venta al por menor.
    expect(payload.activities.map((a) => a.nombre)).toEqual([
      'RESTAURANTES',
      'Venta al por menor de alimentos n.c.p.',
    ]);
    // Los dos proveedores del restaurante apuntan al MISMO nombre.
    expect(payload.mappings).toContainEqual({ emisorId: 'e-1', activityNombre: 'RESTAURANTES' });
    expect(payload.mappings).toContainEqual({ emisorId: 'e-2', activityNombre: 'RESTAURANTES' });
    // El proveedor de la descartada no entra: sería un mapeo al vacío.
    expect(payload.mappings.map((m) => m.emisorId)).not.toContain('e-4');
    expect(droppedMappings.map((m) => m.emisorId)).toEqual(['e-4']);
  });

  it('confirm siempre viaja en true: sin eso el backend no escribe nada', () => {
    const { payload } = buildSeedPayload(RECEPTOR, propuestaReal(), []);
    expect(payload.confirm).toBe(true);
    expect(payload.receptorId).toBe(RECEPTOR);
  });

  it('usa el nombre EDITADO, no el que propuso el DTE', () => {
    const drafts = propuestaReal().map((draft) =>
      draft.codActividad === '56101' ? { ...draft, nombre: 'Restaurante centro' } : draft,
    );

    const { payload } = buildSeedPayload(RECEPTOR, drafts, [mapping('e-1', '56101')]);

    expect(payload.activities[0]).toEqual({
      nombre: 'Restaurante centro',
      codActividad: '56101',
    });
    expect(payload.mappings).toEqual([{ emisorId: 'e-1', activityNombre: 'Restaurante centro' }]);
  });

  it('dedupe por nombre: dos actividades renombradas igual son una sola', () => {
    // Es la otra forma de fusionar: en vez de usar el selector, escribir el
    // mismo nombre en las dos. El resultado tiene que ser el mismo.
    const drafts = propuestaReal().map((draft) =>
      draft.codActividad === '56107' ? { ...draft, nombre: 'RESTAURANTES' } : draft,
    );

    const { payload } = buildSeedPayload(RECEPTOR, drafts, [
      mapping('e-1', '56101'),
      mapping('e-2', '56107'),
    ]);

    expect(payload.activities.filter((a) => a.nombre === 'RESTAURANTES')).toHaveLength(1);
    expect(payload.mappings.every((m) => m.activityNombre === 'RESTAURANTES')).toBe(true);
  });

  it('un nombre vacío descarta la actividad y sus proveedores', () => {
    const drafts = propuestaReal().map((draft) =>
      draft.codActividad === '56101' ? { ...draft, nombre: '   ' } : draft,
    );

    const { payload, droppedMappings } = buildSeedPayload(RECEPTOR, drafts, [
      mapping('e-1', '56101'),
    ]);

    expect(payload.activities.map((a) => a.codActividad)).not.toContain('56101');
    expect(droppedMappings.map((m) => m.emisorId)).toEqual(['e-1']);
  });

  it('un proveedor no puede entrar dos veces: tiene un solo default por receptor', () => {
    const drafts = merge(propuestaReal(), '56107', '56101');

    const { payload } = buildSeedPayload(RECEPTOR, drafts, [
      mapping('e-1', '56101'),
      mapping('e-1', '56107'),
    ]);

    expect(payload.mappings.filter((m) => m.emisorId === 'e-1')).toHaveLength(1);
  });

  it('recorta los espacios del nombre antes de mandarlo', () => {
    const drafts = propuestaReal().map((draft) =>
      draft.codActividad === '56101' ? { ...draft, nombre: '  Restaurante  ' } : draft,
    );

    const { payload } = buildSeedPayload(RECEPTOR, drafts, [mapping('e-1', '56101')]);

    expect(payload.activities).toContainEqual({ nombre: 'Restaurante', codActividad: '56101' });
    expect(payload.mappings).toEqual([{ emisorId: 'e-1', activityNombre: 'Restaurante' }]);
  });
});
