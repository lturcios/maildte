/**
 * Backfill del libro de compras (Addendum 10) sobre TODOS los tenants.
 *
 * Uso:
 *   pnpm run backfill:purchase-book -- --mode=missing
 *   pnpm run backfill:purchase-book -- --mode=missing --dry-run
 *   pnpm run backfill:purchase-book -- --mode=failed --tenant=acme-sa
 *   pnpm run backfill:purchase-book -- --mode=missing --batch=500
 *
 * Por qué existe además del endpoint `POST /purchase-book/reprocess` (RUNBOOK
 * §9): ese endpoint es por tenant y exige un token ADMIN de ese tenant.
 * `PurchaseBookService.reprocess` llama a `requireTenantId()`, que responde
 * `FORBIDDEN_ROLE` al SUPERADMIN, y no hay suplantación de tenant en ninguna
 * parte del sistema. Después del primer despliegue del Addendum 10 hay que
 * encolar los JSON ya archivados de todos los clientes a la vez, y pedirle una
 * credencial a cada uno no es un procedimiento de despliegue. El §9 sigue
 * siendo la vía correcta para reprocesar UN tenant en operación normal.
 *
 * Qué hace exactamente: LEE la base y ENCOLA trabajos en la cola `dte`. No
 * escribe ninguna tabla `purchase_*` ni `dte_*`, no toca IMAP, no toca
 * `lastUid` y no borra nada. El `jobId` es determinístico
 * (`dteParseJobId(attachmentId)`), así que re-ejecutarlo es seguro: dos
 * encolados del mismo adjunto colapsan en un solo trabajo mientras el primero
 * siga en la cola, y el ledger de `DteIngestService` corta el resto.
 *
 * Corre en el HOST (la imagen de producción no trae `ts-node`), igual que
 * `seed:mail-providers`. Necesita alcanzar Postgres Y Redis, incluso con
 * `--dry-run`: el contexto de Nest abre ambas conexiones al arrancar y lo que
 * `--dry-run` evita es el encolado, no la conexión. Ver RUNBOOK §2.c.
 *
 * Salida por `console.log`, igual que el resto de `scripts/`: la regla 25 de
 * CLAUDE.md (pino, nada de console.log) gobierna el código de la aplicación,
 * cuya salida es un log estructurado que alguien agrega; esto es una
 * herramienta de línea de comandos y su salida es para el operador que la está
 * mirando. El logger de la app queda apagado a propósito (`logger: false`).
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma, TenantStatus } from '@prisma/client';
import { CoreModule } from '../src/core.module';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DteQueueModule } from '../src/purchase-book/queue/dte-queue.module';
import { DteEnqueuer } from '../src/purchase-book/queue/dte-enqueuer';
import { buildReprocessWhere } from '../src/purchase-book/purchase-book.service';
import {
  REPROCESS_MODES,
  ReprocessDto,
  ReprocessMode,
} from '../src/purchase-book/dto/reprocess.dto';

/**
 * Mismo contexto que el worker menos el consumo de la cola: CoreModule trae
 * config validada, Prisma y el logger; DteQueueModule trae el `DteEnqueuer`
 * real, que es el que define el contrato del job (jobId determinístico,
 * 3 intentos, backoff exponencial de 30 s). Duplicar esas constantes acá las
 * dejaría derivar respecto de las que usa el sync.
 */
@Module({ imports: [CoreModule, DteQueueModule] })
class BackfillModule {}

/** Tope de `PURCHASE_BOOK_REPROCESS_BATCH` (env.validation.ts) y de `ReprocessDto.limit`. */
const MAX_BATCH = 5000;

const USAGE = `
Backfill del libro de compras sobre todos los tenants.

Uso:
  pnpm run backfill:purchase-book -- --mode=<missing|failed|all> [opciones]

Opciones:
  --mode=<modo>     OBLIGATORIO. Qué adjuntos JSON se encolan:
                      missing  los que nunca pasaron por el parser (caso del
                               primer despliegue del Addendum 10)
                      failed   además los estados de error y los leídos con un
                               parserVersion anterior
                      all      todo, forzando la relectura (conserva Q-T)
  --dry-run         Cuenta y reporta sin encolar nada en Redis.
  --tenant=<ref>    Slug o id de un único tenant. Por defecto, todos.
  --batch=<n>       Tamaño de página (1-${MAX_BATCH}). Por defecto,
                    PURCHASE_BOOK_REPROCESS_BATCH.
  --help            Muestra esta ayuda.

No hay modo por defecto a propósito: es una herramienta de mantenimiento y
adivinar el alcance es peor que fallar.
`.trim();

export interface BackfillOptions {
  mode: ReprocessMode;
  dryRun: boolean;
  tenant?: string;
  batch?: number;
}

export type ParseArgsResult =
  | { ok: true; options: BackfillOptions }
  | { ok: true; help: true }
  | { ok: false; message: string };

function isMode(value: string): value is ReprocessMode {
  return (REPROCESS_MODES as readonly string[]).includes(value);
}

export function parseArgs(argv: string[]): ParseArgsResult {
  let mode: ReprocessMode | undefined;
  let dryRun = false;
  let tenant: string | undefined;
  let batch: number | undefined;

  for (const arg of argv) {
    // pnpm 10 reenvía el `--` separador al script; no es un argumento.
    if (arg === '--') continue;

    if (arg === '--help' || arg === '-h') return { ok: true, help: true };

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      return { ok: false, message: `Argumento no reconocido: "${arg}".` };
    }
    const [, name, value] = match;

    switch (name) {
      case 'mode':
        if (!isMode(value)) {
          return {
            ok: false,
            message: `Modo inválido: "${value}". Valores admitidos: ${REPROCESS_MODES.join(', ')}.`,
          };
        }
        mode = value;
        break;

      case 'tenant':
        if (value.length === 0) {
          return { ok: false, message: '--tenant necesita un slug o un id.' };
        }
        tenant = value;
        break;

      case 'batch': {
        // Entero estricto: "--batch=1e3" o "--batch=10.5" son un error del
        // operador, no algo que haya que interpretar.
        if (!/^\d+$/.test(value)) {
          return { ok: false, message: `--batch debe ser un entero, no "${value}".` };
        }
        const parsed = Number.parseInt(value, 10);
        if (parsed < 1 || parsed > MAX_BATCH) {
          return { ok: false, message: `--batch debe estar entre 1 y ${MAX_BATCH}.` };
        }
        batch = parsed;
        break;
      }

      default:
        return { ok: false, message: `Argumento no reconocido: "${arg}".` };
    }
  }

  if (!mode) {
    return {
      ok: false,
      message: `Falta --mode. Valores admitidos: ${REPROCESS_MODES.join(', ')}.`,
    };
  }

  return { ok: true, options: { mode, dryRun, tenant, batch } };
}

export interface TenantRow {
  id: string;
  slug: string;
  status: TenantStatus;
}

/**
 * Lo que el backfill necesita de la infraestructura. Existe para poder probar
 * la paginación y el aislamiento de fallos por tenant sin una base viva.
 */
export interface BackfillPort {
  /** Adjuntos JSON del tenant, YA scopeados con el contexto de tenant (RLS). */
  listAttachmentIds(
    tenantId: string,
    where: Prisma.AttachmentWhereInput,
    take: number,
    cursor?: string,
  ): Promise<string[]>;
  /** Encola un lote y devuelve cuántos trabajos aceptó Redis. */
  enqueue(tenantId: string, attachmentIds: string[], force: boolean): Promise<number>;
}

export interface TenantOutcome {
  slug: string;
  /**
   * Trabajos efectivamente encolados. En un tenant con error es el conteo
   * PARCIAL: lo que alcanzó a encolar antes de cortarse, no cero.
   */
  enqueued: number;
  /** Tenant no ACTIVO: se enumera pero no se encola. */
  skipped: boolean;
  error?: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * El acumulador vive en un objeto y no en una variable local a propósito: el
 * `catch` de abajo tiene que poder leer cuánto se encoló ANTES del fallo. Antes
 * el error se propagaba y el llamador reportaba `enqueued: 0`, así que un
 * tenant que encoló 8.000 trabajos en dos lotes y falló en el tercero salía en
 * el reporte como "0 ERROR" y el operador no tenía forma de saber por dónde iba
 * ni desde dónde retomar.
 */
async function backfillTenant(
  tenant: TenantRow,
  options: BackfillOptions,
  batch: number,
  port: BackfillPort,
): Promise<{ enqueued: number; error?: string }> {
  // El mismo `where` que arma el endpoint del §9: una sola definición de qué
  // significa cada modo.
  const dto: ReprocessDto = { mode: options.mode };
  const where = buildReprocessWhere(tenant.id, dto);
  const force = options.mode === 'all';

  const progress = { enqueued: 0 };
  let cursor: string | undefined;

  try {
    for (;;) {
      // take = batch + 1 para saber si hay página siguiente sin un count aparte.
      const ids = await port.listAttachmentIds(tenant.id, where, batch + 1, cursor);
      const hasMore = ids.length > batch;
      const page = hasMore ? ids.slice(0, batch) : ids;
      if (page.length === 0) return progress;

      if (!options.dryRun) {
        const accepted = await port.enqueue(tenant.id, page, force);
        // `enqueueParseBulk` no lanza: si Redis rechaza el lote devuelve 0 porque
        // en el sync encolar es una optimización. Acá encolar ES el trabajo, así
        // que un lote perdido tiene que romper el tenant, no reportar "0".
        if (accepted !== page.length) {
          throw new Error(
            `Redis aceptó ${accepted} de ${page.length} trabajos del lote; se corta este tenant`,
          );
        }
      }

      progress.enqueued += page.length;
      if (!hasMore) return progress;
      cursor = page[page.length - 1];
    }
  } catch (err: unknown) {
    return { enqueued: progress.enqueued, error: describeError(err) };
  }
}

/**
 * Recorre los tenants uno por uno. Un tenant que falla no aborta la corrida:
 * queda registrado en su fila del reporte y el proceso sigue con el siguiente
 * (misma regla que un correo que falla dentro de un sync).
 *
 * `onOutcome` se llama apenas termina cada tenant para que el operador vea el
 * avance mientras corre. Un backfill de cientos de miles de adjuntos dura
 * horas: si el reporte solo se imprimiera al final, un Ctrl-C o una caída del
 * SSH no dejarían rastro ni de los tenants que sí terminaron.
 */
export async function backfillTenants(
  tenants: TenantRow[],
  options: BackfillOptions,
  batch: number,
  port: BackfillPort,
  onOutcome?: (outcome: TenantOutcome) => void,
): Promise<TenantOutcome[]> {
  const outcomes: TenantOutcome[] = [];

  const record = (outcome: TenantOutcome): void => {
    outcomes.push(outcome);
    onOutcome?.(outcome);
  };

  for (const tenant of tenants) {
    // El worker revalida el tenant al consumir (`DteIngestService.ingestAttachment`
    // descarta el trabajo si no está ACTIVO). Encolar igual solo generaría miles
    // de trabajos descartados y otras tantas líneas de log.
    if (tenant.status !== 'ACTIVO') {
      record({ slug: tenant.slug, enqueued: 0, skipped: true });
      continue;
    }

    const { enqueued, error } = await backfillTenant(tenant, options, batch, port);
    record({ slug: tenant.slug, enqueued, skipped: false, ...(error ? { error } : {}) });
  }

  return outcomes;
}

/** 16799 -> "16.799". Separador de miles fijo, sin depender del ICU del host. */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Ancho fijo de la columna de conteos. Tiene que ser fijo porque las filas se
 * imprimen a medida que cada tenant termina: en ese momento no se conoce el
 * conteo más largo de la corrida. Siete caracteres alinean hasta "9.999.999";
 * por encima `padStart` no recorta, solo desalinea esa fila.
 */
const COUNT_COLUMN_WIDTH = 7;

function verbFor(dryRun: boolean): string {
  return dryRun ? 'a encolar' : 'encolados';
}

/** Fila de un tenant. `slugWidth` se calcula con la lista de tenants ya cargada. */
export function renderOutcomeLine(
  outcome: TenantOutcome,
  dryRun: boolean,
  slugWidth: number,
): string {
  const verb = verbFor(dryRun);
  const count = formatCount(outcome.enqueued).padStart(COUNT_COLUMN_WIDTH);
  const head = `  tenant ${outcome.slug.padEnd(slugWidth)}  ${count}`;

  if (outcome.skipped) return `${head} omitido (tenant no ACTIVO)`;
  // El conteo de un tenant con error es el PARCIAL: se dice explícitamente para
  // que nadie lo lea como "encoló todo y además falló".
  if (outcome.error) return `${head} ${verb} (parcial); ERROR: ${outcome.error}`;
  return `${head} ${verb}`;
}

/** Cierre del reporte: totales de la corrida. Se imprime después de las filas. */
export function renderSummary(outcomes: TenantOutcome[], dryRun: boolean): string {
  const verb = verbFor(dryRun);

  if (outcomes.length === 0) {
    return ['  (no hay tenants en la base de datos)', '', `  0 tenants, 0 jobs ${verb}`].join('\n');
  }

  const total = outcomes.reduce((sum, outcome) => sum + outcome.enqueued, 0);
  const processed = outcomes.filter((outcome) => !outcome.skipped).length;
  const failed = outcomes.filter((outcome) => outcome.error).length;

  const lines = [
    `  ${'-'.repeat(78)}`,
    `  ${formatCount(processed)} tenants, ${formatCount(total)} jobs ${verb}`,
  ];
  if (failed > 0) {
    lines.push(
      `  ${formatCount(failed)} tenant(s) con error: el conteo de esas filas es parcial, revisarlas arriba.`,
    );
  }

  return lines.join('\n');
}

/** Ancho de la columna de slugs para una lista de tenants ya conocida. */
export function slugColumnWidth(slugs: string[]): number {
  return slugs.reduce((width, slug) => Math.max(width, slug.length), 0);
}

/**
 * Reporte completo. La corrida real imprime fila por fila y después el cierre;
 * esto arma lo mismo de una sola vez y es la definición del formato.
 */
export function renderReport(outcomes: TenantOutcome[], dryRun: boolean): string {
  const slugWidth = slugColumnWidth(outcomes.map((outcome) => outcome.slug));
  const lines = outcomes.map((outcome) => renderOutcomeLine(outcome, dryRun, slugWidth));

  return [...lines, renderSummary(outcomes, dryRun)].join('\n');
}

function createPort(prisma: PrismaService, enqueuer: DteEnqueuer): BackfillPort {
  return {
    listAttachmentIds: (tenantId, where, take, cursor) =>
      // `attachments` tiene RLS con FORCE: sin `withTenant` (SET LOCAL de
      // app.tenant_id) el rol maildte_app ve 0 filas y el backfill reportaría
      // "0 encolados" para todos los tenants sin ningún error visible.
      prisma.withTenant(tenantId, async (tx) => {
        const rows = await tx.attachment.findMany({
          where,
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        return rows.map((row) => row.id);
      }),

    enqueue: (tenantId, attachmentIds, force) =>
      enqueuer.enqueueParseBulk(
        attachmentIds.map((attachmentId) => ({ tenantId, attachmentId })),
        'reprocess',
        force,
      ),
  };
}

/**
 * `tenants` es la única tabla de negocio SIN RLS (ver la migración
 * multi_tenancy): el rol de aplicación puede enumerarla sin contexto de
 * tenant, que es justamente lo que este script necesita para arrancar.
 */
async function loadTenants(prisma: PrismaService, ref?: string): Promise<TenantRow[]> {
  const select = { id: true, slug: true, status: true } as const;

  if (!ref) {
    return prisma.tenant.findMany({ select, orderBy: { slug: 'asc' } });
  }

  // `id` y `slug` son ambos columnas de texto (el id es un uuid generado por
  // Prisma, no un tipo uuid de Postgres), así que un OR resuelve las dos formas
  // de referirse a un tenant sin tener que adivinar cuál escribió el operador.
  return prisma.tenant.findMany({ where: { OR: [{ id: ref }, { slug: ref }] }, select });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.ok) {
    console.error(parsed.message);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }

  const { options } = parsed;

  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const config = app.get(AppConfigService);
    const enqueuer = app.get(DteEnqueuer);
    const batch = options.batch ?? config.purchaseBookReprocessBatch;

    const tenants = await loadTenants(prisma, options.tenant);
    if (options.tenant && tenants.length === 0) {
      console.error(`No existe ningún tenant con slug o id "${options.tenant}".`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `Backfill del libro de compras — modo ${options.mode}, lote ${formatCount(batch)}` +
        `${options.tenant ? `, tenant ${options.tenant}` : ''}` +
        `${options.dryRun ? ', --dry-run (no se encola nada)' : ''}`,
    );
    console.log('');

    // Fila por fila, a medida que cada tenant termina. Una corrida grande dura
    // horas: si el reporte se imprimiera entero al final, un Ctrl-C o una caída
    // del SSH borrarían también lo que ya había terminado bien.
    const slugWidth = slugColumnWidth(tenants.map((tenant) => tenant.slug));
    const outcomes = await backfillTenants(
      tenants,
      options,
      batch,
      createPort(prisma, enqueuer),
      (outcome) => console.log(renderOutcomeLine(outcome, options.dryRun, slugWidth)),
    );
    console.log(renderSummary(outcomes, options.dryRun));

    if (outcomes.some((outcome) => outcome.error)) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

// Solo al ejecutarlo como script. Sin la guarda, importarlo desde el test
// arrancaría un contexto de Nest contra la base real.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Error inesperado en el backfill del libro de compras:', err);
    process.exitCode = 1;
  });
}
