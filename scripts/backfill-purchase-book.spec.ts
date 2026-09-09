import { Prisma } from '@prisma/client';
import {
  BackfillOptions,
  BackfillPort,
  TenantOutcome,
  TenantRow,
  backfillTenants,
  formatCount,
  parseArgs,
  renderOutcomeLine,
  renderReport,
} from './backfill-purchase-book';

function options(overrides: Partial<BackfillOptions> = {}): BackfillOptions {
  return { mode: 'missing', dryRun: false, ...overrides };
}

function tenant(slug: string, overrides: Partial<TenantRow> = {}): TenantRow {
  return { id: `id-${slug}`, slug, status: 'ACTIVO', ...overrides };
}

/**
 * Puerto en memoria: guarda los adjuntos por tenant y registra cada llamada a
 * `enqueue`, para poder afirmar sobre la paginación sin una base viva.
 */
function fakePort(attachments: Record<string, string[]>): BackfillPort & {
  calls: { tenantId: string; ids: string[]; force: boolean }[];
} {
  const calls: { tenantId: string; ids: string[]; force: boolean }[] = [];

  return {
    calls,
    listAttachmentIds: (
      tenantId: string,
      _where: Prisma.AttachmentWhereInput,
      take: number,
      cursor?: string,
    ) => {
      const all = attachments[tenantId] ?? [];
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      return Promise.resolve(all.slice(start, start + take));
    },
    enqueue: (tenantId: string, ids: string[], force: boolean) => {
      calls.push({ tenantId, ids, force });
      return Promise.resolve(ids.length);
    },
  };
}

describe('parseArgs', () => {
  it('exige --mode: sin modo no hay valor por defecto', () => {
    const result = parseArgs([]);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('Falta --mode') });
  });

  it('rechaza un modo desconocido', () => {
    const result = parseArgs(['--mode=todo']);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('Modo inválido') });
  });

  it('rechaza un argumento desconocido', () => {
    const result = parseArgs(['--mode=missing', '--forzar']);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Argumento no reconocido'),
    });
  });

  it('acepta los tres modos', () => {
    for (const mode of ['missing', 'failed', 'all'] as const) {
      expect(parseArgs([`--mode=${mode}`])).toEqual({
        ok: true,
        options: { mode, dryRun: false, tenant: undefined, batch: undefined },
      });
    }
  });

  it('lee --dry-run, --tenant y --batch', () => {
    expect(parseArgs(['--mode=failed', '--dry-run', '--tenant=acme-sa', '--batch=250'])).toEqual({
      ok: true,
      options: { mode: 'failed', dryRun: true, tenant: 'acme-sa', batch: 250 },
    });
  });

  it('rechaza un --batch no entero o fuera de rango', () => {
    expect(parseArgs(['--mode=missing', '--batch=10.5'])).toMatchObject({ ok: false });
    expect(parseArgs(['--mode=missing', '--batch=0'])).toMatchObject({ ok: false });
    expect(parseArgs(['--mode=missing', '--batch=5001'])).toMatchObject({ ok: false });
    expect(parseArgs(['--mode=missing', '--batch=5000'])).toMatchObject({ ok: true });
  });

  it('reconoce --help', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: true, help: true });
  });

  it('ignora el separador "--" que reenvía pnpm', () => {
    expect(parseArgs(['--', '--mode=missing', '--dry-run'])).toEqual({
      ok: true,
      options: { mode: 'missing', dryRun: true, tenant: undefined, batch: undefined },
    });
  });
});

describe('backfillTenants', () => {
  it('pagina con cursor y encola cada lote una sola vez', async () => {
    const port = fakePort({ 'id-acme': ['a1', 'a2', 'a3', 'a4', 'a5'] });

    const outcomes = await backfillTenants([tenant('acme')], options(), 2, port);

    expect(outcomes).toEqual([{ slug: 'acme', enqueued: 5, skipped: false }]);
    expect(port.calls.map((call) => call.ids)).toEqual([['a1', 'a2'], ['a3', 'a4'], ['a5']]);
  });

  it('no encola nada en --dry-run pero cuenta igual', async () => {
    const port = fakePort({ 'id-acme': ['a1', 'a2', 'a3'] });

    const outcomes = await backfillTenants([tenant('acme')], options({ dryRun: true }), 2, port);

    expect(outcomes).toEqual([{ slug: 'acme', enqueued: 3, skipped: false }]);
    expect(port.calls).toHaveLength(0);
  });

  it('usa force solo en modo all', async () => {
    const port = fakePort({ 'id-acme': ['a1'] });

    await backfillTenants([tenant('acme')], options({ mode: 'all' }), 10, port);
    await backfillTenants([tenant('acme')], options({ mode: 'missing' }), 10, port);

    expect(port.calls.map((call) => call.force)).toEqual([true, false]);
  });

  it('omite los tenants no ACTIVOS sin encolarles nada', async () => {
    const port = fakePort({ 'id-suspendido': ['a1', 'a2'] });

    const outcomes = await backfillTenants(
      [tenant('suspendido', { status: 'SUSPENDIDO' })],
      options(),
      10,
      port,
    );

    expect(outcomes).toEqual([{ slug: 'suspendido', enqueued: 0, skipped: true }]);
    expect(port.calls).toHaveLength(0);
  });

  it('un tenant que falla no aborta la corrida', async () => {
    const port = fakePort({ 'id-a': ['a1'], 'id-b': ['b1'], 'id-c': ['c1'] });
    const listAll = port.listAttachmentIds;
    port.listAttachmentIds = (tenantId, where, take, cursor) =>
      tenantId === 'id-b'
        ? Promise.reject(new Error('conexión perdida'))
        : listAll(tenantId, where, take, cursor);

    const outcomes = await backfillTenants(
      [tenant('a'), tenant('b'), tenant('c')],
      options(),
      10,
      port,
    );

    expect(outcomes).toEqual([
      { slug: 'a', enqueued: 1, skipped: false },
      { slug: 'b', enqueued: 0, skipped: false, error: 'conexión perdida' },
      { slug: 'c', enqueued: 1, skipped: false },
    ]);
  });

  it('trata un lote parcialmente aceptado por Redis como error del tenant', async () => {
    const port = fakePort({ 'id-acme': ['a1', 'a2'] });
    port.enqueue = () => Promise.resolve(0); // enqueueParseBulk devuelve 0 si Redis falla

    const outcomes = await backfillTenants([tenant('acme')], options(), 10, port);

    expect(outcomes[0].error).toContain('Redis aceptó 0 de 2');
  });

  /**
   * Regresión: el acumulador de páginas se perdía al propagar el error y el
   * llamador reportaba `enqueued: 0`. Un tenant que encoló dos lotes completos
   * y se cortó en el tercero salía como "0 ERROR", así que el operador no podía
   * responder "¿hasta dónde llegó?" ni decidir si valía la pena reintentar.
   */
  it('conserva el conteo parcial cuando falla después de encolar varios lotes', async () => {
    const port = fakePort({ 'id-acme': ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] });
    const enqueueOk = port.enqueue;
    let batchNumber = 0;
    port.enqueue = (tenantId, ids, force) => {
      batchNumber += 1;
      // Los dos primeros lotes entran; el tercero lo rechaza Redis entero.
      return batchNumber >= 3 ? Promise.resolve(0) : enqueueOk(tenantId, ids, force);
    };

    const outcomes = await backfillTenants([tenant('acme')], options(), 2, port);

    expect(outcomes[0].enqueued).toBe(4); // los lotes 1 y 2, no 0
    expect(outcomes[0].error).toContain('Redis aceptó 0 de 2');
  });

  it('conserva el conteo parcial cuando la base se cae a mitad de la paginación', async () => {
    const port = fakePort({ 'id-acme': ['a1', 'a2', 'a3', 'a4', 'a5'] });
    const listOk = port.listAttachmentIds;
    let listCalls = 0;
    port.listAttachmentIds = (tenantId, where, take, cursor) => {
      listCalls += 1;
      return listCalls >= 3
        ? Promise.reject(new Error('conexión perdida'))
        : listOk(tenantId, where, take, cursor);
    };

    const outcomes = await backfillTenants([tenant('acme')], options(), 2, port);

    expect(outcomes[0].enqueued).toBe(4);
    expect(outcomes[0].error).toBe('conexión perdida');
  });

  it('reporta el conteo parcial en la fila del tenant', () => {
    const line = renderOutcomeLine(
      { slug: 'acme', enqueued: 4, skipped: false, error: 'Redis aceptó 0 de 2' },
      false,
      4,
    );

    expect(line).toContain('4 encolados (parcial); ERROR: Redis aceptó 0 de 2');
  });

  /**
   * El reporte tiene que salir a medida que cada tenant termina: un backfill de
   * cientos de miles de adjuntos dura horas y un Ctrl-C o una caída del SSH no
   * pueden borrar también lo que ya había terminado bien.
   */
  it('avisa de cada tenant apenas termina, no al final de la corrida', async () => {
    const seen: TenantOutcome[] = [];
    const port = fakePort({ 'id-a': ['a1'], 'id-b': ['b1'] });
    const listOk = port.listAttachmentIds;
    port.listAttachmentIds = (tenantId, where, take, cursor) => {
      // Cuando arranca el segundo tenant, el primero ya tiene que estar avisado.
      if (tenantId === 'id-b') expect(seen.map((outcome) => outcome.slug)).toEqual(['a']);
      return listOk(tenantId, where, take, cursor);
    };

    const outcomes = await backfillTenants(
      [tenant('a'), tenant('b'), tenant('omitido', { status: 'SUSPENDIDO' })],
      options(),
      10,
      port,
      (outcome) => seen.push(outcome),
    );

    expect(seen).toEqual(outcomes);
    expect(seen.map((outcome) => outcome.slug)).toEqual(['a', 'b', 'omitido']);
  });
});

describe('renderReport', () => {
  it('formatea los miles con punto', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(16799)).toBe('16.799');
    expect(formatCount(1234567)).toBe('1.234.567');
  });

  it('alinea las filas y suma el total', () => {
    const report = renderReport(
      [
        { slug: 'acme-sa', enqueued: 12480, skipped: false },
        { slug: 'distribuidora', enqueued: 3902, skipped: false },
        { slug: 'tercera', enqueued: 417, skipped: false },
      ],
      false,
    );

    const lines = report.split('\n');
    expect(lines[0]).toMatch(/^ {2}tenant acme-sa {2,}12\.480 encolados$/);
    expect(lines[1]).toMatch(/^ {2}tenant distribuidora {2,}3\.902 encolados$/);
    // La columna de conteos queda alineada entre filas de slug distinto.
    expect(lines[1].indexOf('encolados')).toBe(lines[0].indexOf('encolados'));
    expect(lines[2].indexOf('encolados')).toBe(lines[0].indexOf('encolados'));
    expect(report).toContain('3 tenants, 16.799 jobs encolados');
  });

  it('no cuenta los tenants omitidos como procesados', () => {
    const report = renderReport(
      [
        { slug: 'acme', enqueued: 5, skipped: false },
        { slug: 'suspendido', enqueued: 0, skipped: true },
      ],
      false,
    );

    expect(report).toContain('omitido (tenant no ACTIVO)');
    expect(report).toContain('1 tenants, 5 jobs encolados');
  });

  it('dice claramente que un dry-run no encoló nada', () => {
    const report = renderReport([{ slug: 'acme', enqueued: 5, skipped: false }], true);
    expect(report).toContain('a encolar');
    expect(report).not.toContain('encolados');
  });

  it('imprime algo sensato cuando no hay ningún tenant', () => {
    const report = renderReport([], false);
    expect(report).toContain('(no hay tenants en la base de datos)');
    expect(report).toContain('0 tenants, 0 jobs encolados');
  });

  it('marca la corrida cuando algún tenant falló', () => {
    const report = renderReport(
      [{ slug: 'acme', enqueued: 0, skipped: false, error: 'conexión perdida' }],
      false,
    );
    expect(report).toContain('ERROR: conexión perdida');
    expect(report).toContain('1 tenant(s) con error');
  });
});
