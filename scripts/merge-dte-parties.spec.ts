import {
  GroupOutcome,
  GroupPlan,
  MergeOptions,
  MergePort,
  PartyRow,
  TenantRow,
  canonicalKeyLabel,
  formatCount,
  mergeTenants,
  parseArgs,
  planGroup,
  renderGroup,
  renderReport,
} from './merge-dte-parties';

function options(overrides: Partial<MergeOptions> = {}): MergeOptions {
  return { apply: false, ...overrides };
}

function tenant(slug: string): TenantRow {
  return { id: `id-${slug}`, slug };
}

/**
 * Una parte con los valores por defecto del caso sano. Los overrides son lo que
 * cada test quiere probar, así que la fixture no debe llevar nada llamativo.
 */
function party(nit: string, overrides: Partial<PartyRow> = {}): PartyRow {
  return {
    id: `party-${nit}`,
    tenantId: 'id-acme',
    nit,
    dui: null,
    nrc: '1435153',
    canonicalKey: '1435153',
    nombre: 'JOSE WALTER CRUZ MARAVILLA',
    nombreComercial: null,
    codActividad: null,
    descActividad: null,
    departamento: null,
    municipio: null,
    distrito: null,
    complemento: null,
    telefono: null,
    correo: null,
    seenAsEmisor: false,
    seenAsReceptor: true,
    defaultTipoOperacion: null,
    defaultClasificacion: null,
    defaultSector: null,
    defaultTipoCostoGasto: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    documentsAsEmisor: 0,
    documentsAsReceptor: 0,
    ...overrides,
  };
}

/**
 * Puerto en memoria: guarda los grupos por tenant y registra cada plan
 * aplicado, para poder afirmar sobre la fusión sin una base viva.
 */
function fakePort(groups: Record<string, [string, PartyRow[]][]>): MergePort & {
  applied: { tenantId: string; plan: GroupPlan }[];
} {
  const applied: { tenantId: string; plan: GroupPlan }[] = [];

  return {
    applied,
    listGroups: (tenantId: string) => Promise.resolve(groups[tenantId] ?? []),
    applyPlan: (tenantId: string, plan: GroupPlan) => {
      applied.push({ tenantId, plan });
      // Idempotencia: las hermanas dejan de existir, así que el grupo
      // desaparece de la próxima enumeración igual que en la base real.
      groups[tenantId] = (groups[tenantId] ?? []).filter(([key]) => key !== plan.canonicalKey);
      return Promise.resolve();
    },
  };
}

describe('parseArgs', () => {
  it('--dry-run es el default: sin flags no se aplica nada', () => {
    expect(parseArgs([])).toEqual({ ok: true, options: { apply: false, tenant: undefined } });
  });

  it('--apply es lo único que habilita la escritura', () => {
    expect(parseArgs(['--apply'])).toEqual({
      ok: true,
      options: { apply: true, tenant: undefined },
    });
  });

  it('acepta --dry-run explícito sin cambiar nada', () => {
    expect(parseArgs(['--dry-run'])).toEqual({
      ok: true,
      options: { apply: false, tenant: undefined },
    });
  });

  it('rechaza --apply y --dry-run juntos en vez de elegir uno', () => {
    expect(parseArgs(['--apply', '--dry-run'])).toEqual({
      ok: false,
      message: expect.stringContaining('excluyentes'),
    });
  });

  it('lee --tenant', () => {
    expect(parseArgs(['--tenant=wendy-cocar', '--apply'])).toEqual({
      ok: true,
      options: { apply: true, tenant: 'wendy-cocar' },
    });
  });

  it('rechaza --tenant vacío', () => {
    expect(parseArgs(['--tenant='])).toMatchObject({ ok: false });
  });

  it('rechaza un argumento desconocido', () => {
    expect(parseArgs(['--forzar'])).toEqual({
      ok: false,
      message: expect.stringContaining('Argumento no reconocido'),
    });
  });

  it('reconoce --help', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: true, help: true });
  });

  it('ignora el separador "--" que reenvía pnpm', () => {
    expect(parseArgs(['--', '--apply'])).toEqual({
      ok: true,
      options: { apply: true, tenant: undefined },
    });
  });
});

describe('planGroup — elección de la canónica', () => {
  it('gana la parte con más documentos', () => {
    const plan = planGroup('1435153', [
      party('022560911', { documentsAsReceptor: 7 }),
      party('11022205761034', { documentsAsReceptor: 849 }),
    ]);

    expect(plan.canonical.nit).toBe('11022205761034');
    expect(plan.absorbed.map((p) => p.nit)).toEqual(['022560911']);
    expect(plan.reassigned).toBe(7);
    expect(plan.totalDocuments).toBe(856);
  });

  it('cuenta los dos roles: el contribuyente también puede estar partido como emisor', () => {
    const plan = planGroup('1435153', [
      party('a', { id: 'a', documentsAsReceptor: 10, documentsAsEmisor: 0 }),
      party('b', { id: 'b', documentsAsReceptor: 2, documentsAsEmisor: 40 }),
    ]);

    expect(plan.canonical.id).toBe('b');
    expect(plan.reassigned).toBe(10);
  });

  it('con empate de documentos gana la de createdAt más antiguo', () => {
    const plan = planGroup('1435153', [
      party('nueva', {
        id: 'nueva',
        documentsAsReceptor: 5,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      party('vieja', {
        id: 'vieja',
        documentsAsReceptor: 5,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ]);

    expect(plan.canonical.id).toBe('vieja');
  });

  it('con empate también de createdAt desempata por id, para no depender del orden de Postgres', () => {
    const rows = [party('x', { id: 'zzz' }), party('y', { id: 'aaa' })];

    expect(planGroup('1435153', rows).canonical.id).toBe('aaa');
    expect(planGroup('1435153', [...rows].reverse()).canonical.id).toBe('aaa');
  });
});

describe('planGroup — consolidación', () => {
  it('la canónica conserva su nit y absorbe el dui de la hermana', () => {
    const plan = planGroup('1435153', [
      party('11022205761034', { documentsAsReceptor: 849 }),
      party('022560911', { documentsAsReceptor: 7, dui: '022560911' }),
    ]);

    expect(plan.update.dui).toBe('022560911');
    expect(plan.update).not.toHaveProperty('nit');
  });

  it('deduce el dui del nit de 9 dígitos de la hermana si su columna dui está vacía', () => {
    const plan = planGroup('1435153', [
      party('11022205761034', { documentsAsReceptor: 849 }),
      party('022560911', { documentsAsReceptor: 7, dui: null }),
    ]);

    expect(plan.update.dui).toBe('022560911');
  });

  it('no pisa un dui ni un nrc ya presentes en la canónica', () => {
    const plan = planGroup('1435153', [
      party('11022205761034', { documentsAsReceptor: 849, dui: '099999999', nrc: '1435153' }),
      party('022560911', { documentsAsReceptor: 7, dui: '022560911', nrc: '0001435153' }),
    ]);

    expect(plan.update).not.toHaveProperty('dui');
    expect(plan.update).not.toHaveProperty('nrc');
  });

  it('llena el nrc de la canónica cuando está vacío', () => {
    const plan = planGroup('11022205761034', [
      party('11022205761034', { documentsAsReceptor: 849, nrc: null }),
      party('022560911', { documentsAsReceptor: 7, nrc: '1435153' }),
    ]);

    expect(plan.update.nrc).toBe('1435153');
  });

  it('acumula los flags con OR y no los apaga', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 849, seenAsEmisor: false, seenAsReceptor: true }),
      party('chica', { documentsAsReceptor: 7, seenAsEmisor: true, seenAsReceptor: false }),
    ]);

    expect(plan.update.seenAsEmisor).toBe(true);
    expect(plan.update).not.toHaveProperty('seenAsReceptor');
  });
});

describe('planGroup — defaults Q–T', () => {
  const clasificados = {
    defaultTipoOperacion: 1,
    defaultClasificacion: 2,
    defaultSector: 3,
    defaultTipoCostoGasto: 4,
  };

  it('la canónica conserva su bloque y el conflicto se reporta', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 849, ...clasificados }),
      party('chica', {
        documentsAsReceptor: 7,
        defaultTipoOperacion: 2,
        defaultClasificacion: 2,
        defaultSector: 3,
        defaultTipoCostoGasto: 4,
      }),
    ]);

    // Gana la de más documentos: no se escribe nada sobre la canónica.
    expect(plan.update).not.toHaveProperty('defaultTipoOperacion');

    const conflict = plan.notes.find((note) => note.label === 'CONFLICTO');
    expect(conflict?.message).toContain('gana grande');
    expect(conflict?.detail).toEqual([
      { identifier: 'grande', value: 'Q=1 R=2 S=3 T=4' },
      { identifier: 'chica', value: 'Q=2 R=2 S=3 T=4' },
    ]);
  });

  it('nunca mezcla columnas: adopta el bloque entero de la hermana cuando la canónica no tiene ninguno', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 849 }),
      party('chica', {
        documentsAsReceptor: 7,
        defaultTipoOperacion: 1,
        defaultClasificacion: null,
        defaultSector: 3,
        defaultTipoCostoGasto: null,
      }),
    ]);

    // Las cuatro columnas salen de la MISMA parte, nulas incluidas.
    expect(plan.update.defaultTipoOperacion).toBe(1);
    expect(plan.update.defaultClasificacion).toBeNull();
    expect(plan.update.defaultSector).toBe(3);
    expect(plan.update.defaultTipoCostoGasto).toBeNull();
    expect(plan.notes).toHaveLength(0);
  });

  it('dos bloques idénticos no son un conflicto', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 849, ...clasificados }),
      party('chica', { documentsAsReceptor: 7, ...clasificados }),
    ]);

    expect(plan.notes).toHaveLength(0);
  });

  it('avisa cuando los nombres no coinciden, que es la evidencia de que quizá no sean la misma persona', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 849, nombre: 'JOSE WALTER CRUZ MARAVILLA' }),
      party('chica', { documentsAsReceptor: 7, nombre: 'OTRA PERSONA S.A. DE C.V.' }),
    ]);

    expect(plan.notes.map((note) => note.label)).toEqual(['AVISO']);
  });
});

describe('canonicalKeyLabel', () => {
  it('rotula la rama de la cascada que resolvió la clave', () => {
    const conNrc = [party('11022205761034', { nrc: '0001435153' })];
    expect(canonicalKeyLabel('1435153', conNrc)).toBe('nrc');

    const sinNrc = [party('11022205761034', { nrc: null })];
    expect(canonicalKeyLabel('11022205761034', sinNrc)).toBe('nit');
    expect(canonicalKeyLabel('022560911', sinNrc)).toBe('dui');
  });
});

describe('mergeTenants', () => {
  const grupoReal: [string, PartyRow[]][] = [
    [
      '1435153',
      [
        party('11022205761034', { id: 'canonica', documentsAsReceptor: 849 }),
        party('022560911', { id: 'hermana', documentsAsReceptor: 7, dui: '022560911' }),
      ],
    ],
  ];

  it('--dry-run no escribe nada pero reporta el plan completo', async () => {
    const port = fakePort({ 'id-wendy-cocar': grupoReal });

    const outcomes = await mergeTenants([tenant('wendy-cocar')], options(), port);

    expect(port.applied).toHaveLength(0);
    expect(outcomes[0].groups[0].plan.canonical.id).toBe('canonica');
    expect(outcomes[0].groups[0].plan.reassigned).toBe(7);
  });

  it('con --apply fusiona y la segunda corrida no encuentra nada (idempotencia)', async () => {
    const port = fakePort({ 'id-wendy-cocar': [...grupoReal] });

    const primera = await mergeTenants([tenant('wendy-cocar')], options({ apply: true }), port);
    expect(port.applied).toHaveLength(1);
    expect(primera[0].groups).toHaveLength(1);

    const segunda = await mergeTenants([tenant('wendy-cocar')], options({ apply: true }), port);
    expect(port.applied).toHaveLength(1);
    expect(segunda[0].groups).toHaveLength(0);
  });

  it('un tenant que falla al enumerar no aborta a los demás', async () => {
    const port = fakePort({ 'id-a': grupoReal, 'id-c': grupoReal });
    const listOk = port.listGroups;
    port.listGroups = (tenantId) =>
      tenantId === 'id-b' ? Promise.reject(new Error('conexión perdida')) : listOk(tenantId);

    const outcomes = await mergeTenants([tenant('a'), tenant('b'), tenant('c')], options(), port);

    expect(outcomes.map((outcome) => outcome.slug)).toEqual(['a', 'b', 'c']);
    expect(outcomes[1]).toEqual({ slug: 'b', groups: [], error: 'conexión perdida' });
    expect(outcomes[0].groups).toHaveLength(1);
    expect(outcomes[2].groups).toHaveLength(1);
  });

  it('un grupo que falla no arrastra a los demás grupos del tenant', async () => {
    const dosGrupos: [string, PartyRow[]][] = [
      [
        'clave-a',
        [
          party('a1', { id: 'a1', canonicalKey: 'clave-a', documentsAsReceptor: 9 }),
          party('a2', { id: 'a2', canonicalKey: 'clave-a', documentsAsReceptor: 1 }),
        ],
      ],
      [
        'clave-b',
        [
          party('b1', { id: 'b1', canonicalKey: 'clave-b', documentsAsReceptor: 9 }),
          party('b2', { id: 'b2', canonicalKey: 'clave-b', documentsAsReceptor: 1 }),
        ],
      ],
    ];
    const port = fakePort({ 'id-acme': dosGrupos });
    port.applyPlan = (_tenantId, plan) =>
      plan.canonicalKey === 'clave-a'
        ? Promise.reject(new Error('deadlock detectado'))
        : Promise.resolve();

    const outcomes = await mergeTenants([tenant('acme')], options({ apply: true }), port);

    expect(outcomes[0].groups[0].error).toBe('deadlock detectado');
    expect(outcomes[0].groups[1].error).toBeUndefined();
  });

  it('avisa de cada grupo apenas termina, no al final de la corrida', async () => {
    const seen: string[] = [];
    const port = fakePort({ 'id-a': grupoReal, 'id-b': grupoReal });
    const listOk = port.listGroups;
    port.listGroups = (tenantId) => {
      // Cuando arranca el segundo tenant, el grupo del primero ya tiene que
      // estar avisado: una interrupción no puede borrar lo ya fusionado.
      if (tenantId === 'id-b') expect(seen).toEqual(['a']);
      return listOk(tenantId);
    };

    await mergeTenants([tenant('a'), tenant('b')], options(), port, {
      onGroup: (slug) => seen.push(slug),
    });

    expect(seen).toEqual(['a', 'b']);
  });
});

describe('renderReport', () => {
  it('formatea los miles con punto', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(16799)).toBe('16.799');
  });

  /** El §4 del addendum dibuja esta salida exacta para el caso de producción. */
  it('reproduce la salida esperada del caso conocido', () => {
    const plan = planGroup('1435153', [
      party('11022205761034', { documentsAsReceptor: 849 }),
      party('022560911', { documentsAsReceptor: 7, dui: '022560911' }),
    ]);

    const report = renderReport([{ slug: 'wendy-cocar', groups: [{ plan }] }], options());

    expect(report).toBe(
      [
        '  tenant wendy-cocar',
        '    JOSE WALTER CRUZ MARAVILLA  nrc 1435153',
        '      canónica : 11022205761034  (849 documentos)',
        '      absorbe  : 022560911       (7 documentos)   -> 856 tras fusionar',
        `  ${'-'.repeat(66)}`,
        '  1 tenant, 1 grupo, 2 partes -> 1, 7 documentos reasignados',
      ].join('\n'),
    );
  });

  it('no imprime fila para un tenant sin grupos ni lo cuenta en el total', () => {
    const report = renderReport(
      [
        { slug: 'rosa-alvarez', groups: [] },
        { slug: 'wendy-cocar', groups: [] },
      ],
      options(),
    );

    expect(report).not.toContain('rosa-alvarez');
    expect(report).toContain('(no hay partes para fusionar)');
    expect(report).toContain('0 tenants, 0 grupos, 0 partes -> 0, 0 documentos reasignados');
  });

  it('marca la corrida cuando un tenant no se pudo enumerar', () => {
    const report = renderReport(
      [{ slug: 'acme', groups: [], error: 'conexión perdida' }],
      options(),
    );

    expect(report).toContain('tenant acme  ERROR: conexión perdida');
    expect(report).toContain('con error');
  });

  it('dice que el grupo con error quedó sin cambios y no vuelca ninguna parte borrada', () => {
    const plan = planGroup('1435153', [
      party('grande', { documentsAsReceptor: 9 }),
      party('chica', { documentsAsReceptor: 1 }),
    ]);
    const outcome: GroupOutcome = { plan, error: 'deadlock detectado' };

    const lines = renderGroup(outcome, true).join('\n');

    expect(lines).toContain('el grupo no se fusionó (sin cambios): deadlock detectado');
    expect(lines).not.toContain('BORRADA');
  });

  it('vuelca el contenido completo de cada parte absorbida antes de borrarla, solo con --apply', () => {
    const plan = planGroup('1435153', [
      party('11022205761034', { documentsAsReceptor: 849 }),
      party('022560911', { id: 'hermana', documentsAsReceptor: 7, dui: '022560911' }),
    ]);

    expect(renderGroup({ plan }, false).join('\n')).not.toContain('BORRADA');

    const applied = renderGroup({ plan }, true).join('\n');
    expect(applied).toContain('BORRADA   022560911 (id hermana)');
    expect(applied).toContain('nit');
    expect(applied).toContain('nombre');
    expect(applied).toContain('canonicalKey');
    expect(applied).toContain('createdAt');
    expect(applied).toContain('documentos');
  });
});
