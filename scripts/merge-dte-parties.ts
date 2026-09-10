/**
 * Fusión de las partes que son el mismo contribuyente partido en dos filas
 * (Addendum 11, §4 — fase 2, punto 3).
 *
 * Uso:
 *   pnpm run merge:dte-parties -- --dry-run
 *   pnpm run merge:dte-parties -- --tenant=wendy-cocar
 *   pnpm run merge:dte-parties -- --tenant=wendy-cocar --apply
 *
 * Por qué existe. Unos proveedores identifican al contribuyente con el NIT de
 * 14 dígitos y otros con el homologado al DUI, de 9. Mientras la identidad de
 * `DteParty` fue el `nit`, el mismo contribuyente terminó como dos filas, y
 * desde el Addendum 10 el export del Anexo 3 exige un único `receptorId`:
 * exportar una de las dos partes deja las compras de la otra **fuera de la
 * declaración**, sin error y sin aviso. La fase 2 ya cerró la fuente —la
 * ingesta resuelve por `canonicalKey`, así que no se crean partes nuevas
 * partidas— y esto limpia el histórico que quedó.
 *
 * Qué hace exactamente: agrupa las partes por `(tenantId, canonicalKey)`,
 * elige una canónica por grupo, le reasigna los documentos de sus hermanas,
 * consolida flags e identificadores, y borra las hermanas. No toca IMAP, no
 * toca `lastUid`, no toca el storage y no encola nada: solo la base.
 *
 * `--dry-run` es el DEFAULT y la fusión real exige `--apply`. Es un cambio
 * contable sobre datos de clientes (regla de `CLAUDE.md` sobre migrar datos
 * desde código de aplicación: hace falta un flag explícito de mantenimiento).
 *
 * Idempotente: la segunda corrida no encuentra grupos, porque el criterio de
 * agrupación es el mismo que quedó consolidado.
 *
 * Corre en el HOST, no dentro del contenedor: la imagen de producción no trae
 * `ts-node` ni `pnpm` (el modo de falla está explicado en el RUNBOOK §9.b).
 * Necesita alcanzar Postgres; a diferencia del backfill, NO necesita Redis.
 *
 * Salida por `console.log`, igual que el resto de `scripts/`: la regla 25 de
 * CLAUDE.md (pino, nada de console.log) gobierna el código de la aplicación,
 * cuya salida es un log estructurado que alguien agrega; esto es una
 * herramienta de línea de comandos y su salida ES su interfaz.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DteParty } from '@prisma/client';
import { ConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { splitSupplierId } from '../src/purchase-book/anexo/split-supplier-id';
import { onlyDigits, stripLeadingZeros } from '../src/purchase-book/identity/digits';

/**
 * Contexto mínimo: config validada y Prisma. A propósito NO se importa
 * `CoreModule` como hace el backfill — ese trae `RedisModule` y `CryptoModule`,
 * y este script no encola nada ni descifra credenciales. Abrir una conexión a
 * Redis solo para leer y escribir Postgres agregaría un modo de falla (y una
 * variable de entorno en la línea de comandos) que no le corresponde a una
 * herramienta que, por definición del addendum, solo toca la base.
 *
 * La validación Joi de `ConfigModule` sigue exigiendo el `.env` completo
 * (`REDIS_URL` incluido): valida el entorno, no lo usa.
 */
@Module({ imports: [ConfigModule, PrismaModule] })
class MergePartiesModule {}

const USAGE = `
Fusiona las partes que son el mismo contribuyente partido en dos filas.

Uso:
  pnpm run merge:dte-parties -- [opciones]

Opciones:
  --dry-run         Reporta lo que haría sin escribir nada. Es el DEFAULT.
  --apply           Aplica la fusión. Obligatorio para escribir en la base.
  --tenant=<ref>    Slug o id de un único tenant. Por defecto, todos.
  --help            Muestra esta ayuda.

El default es no tocar nada a propósito: la fusión es un cambio contable sobre
datos de clientes y se confirma a mano (Addendum 11, §5).
`.trim();

export interface MergeOptions {
  /** `false` = --dry-run. La fusión real exige --apply explícito. */
  apply: boolean;
  tenant?: string;
}

export type ParseArgsResult =
  { ok: true; options: MergeOptions } | { ok: true; help: true } | { ok: false; message: string };

export function parseArgs(argv: string[]): ParseArgsResult {
  let apply = false;
  let dryRun = false;
  let tenant: string | undefined;

  for (const arg of argv) {
    // pnpm 10 reenvía el `--` separador al script; no es un argumento.
    if (arg === '--') continue;

    if (arg === '--help' || arg === '-h') return { ok: true, help: true };

    // `--dry-run` es redundante con el default, pero se acepta: el
    // procedimiento del RUNBOOK lo escribe para que el ensayo se lea distinto
    // de la corrida real en el historial de la shell.
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }

    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      return { ok: false, message: `Argumento no reconocido: "${arg}".` };
    }
    const [, name, value] = match;

    switch (name) {
      case 'tenant':
        if (value.length === 0) {
          return { ok: false, message: '--tenant necesita un slug o un id.' };
        }
        tenant = value;
        break;

      default:
        return { ok: false, message: `Argumento no reconocido: "${arg}".` };
    }
  }

  // Pedir las dos cosas a la vez no es una preferencia ambigua que se pueda
  // resolver con una precedencia: es una contradicción, y adivinar cuál gana en
  // una herramienta que borra filas es peor que fallar.
  if (apply && dryRun) {
    return { ok: false, message: '--apply y --dry-run son excluyentes: elegí uno.' };
  }

  return { ok: true, options: { apply, tenant } };
}

export interface TenantRow {
  id: string;
  slug: string;
}

/**
 * Una parte con el conteo de documentos en los que participa, en cada rol. Se
 * apoya en el tipo generado por Prisma para que agregar una columna a
 * `DteParty` no deje al volcado de la parte borrada incompleto en silencio.
 */
export type PartyRow = DteParty & {
  documentsAsEmisor: number;
  documentsAsReceptor: number;
};

/**
 * Total de documentos de una parte: es el criterio de elección de la canónica.
 *
 * Se suman los dos roles porque la fusión reasigna los dos (`receptorId` y
 * `emisorId`): el mismo contribuyente puede haber quedado partido también del
 * lado emisor, y elegir la canónica mirando solo un rol dejaría como absorbida
 * a la parte que en realidad concentra el histórico.
 */
export function documentCount(party: PartyRow): number {
  return party.documentsAsEmisor + party.documentsAsReceptor;
}

/** Los cuatro defaults del Anexo 3, como bloque indivisible. */
export interface DefaultsBlock {
  defaultTipoOperacion: number | null;
  defaultClasificacion: number | null;
  defaultSector: number | null;
  defaultTipoCostoGasto: number | null;
}

function defaultsOf(party: PartyRow): DefaultsBlock {
  return {
    defaultTipoOperacion: party.defaultTipoOperacion,
    defaultClasificacion: party.defaultClasificacion,
    defaultSector: party.defaultSector,
    defaultTipoCostoGasto: party.defaultTipoCostoGasto,
  };
}

function hasDefaults(block: DefaultsBlock): boolean {
  return (
    block.defaultTipoOperacion !== null ||
    block.defaultClasificacion !== null ||
    block.defaultSector !== null ||
    block.defaultTipoCostoGasto !== null
  );
}

function sameDefaults(a: DefaultsBlock, b: DefaultsBlock): boolean {
  return (
    a.defaultTipoOperacion === b.defaultTipoOperacion &&
    a.defaultClasificacion === b.defaultClasificacion &&
    a.defaultSector === b.defaultSector &&
    a.defaultTipoCostoGasto === b.defaultTipoCostoGasto
  );
}

/** `Q=1 R=2 S=- T=4`. Q/R/S/T son las columnas del Anexo 3, en ese orden. */
export function renderDefaults(block: DefaultsBlock): string {
  const cell = (value: number | null): string => (value === null ? '-' : String(value));
  return (
    `Q=${cell(block.defaultTipoOperacion)} ` +
    `R=${cell(block.defaultClasificacion)} ` +
    `S=${cell(block.defaultSector)} ` +
    `T=${cell(block.defaultTipoCostoGasto)}`
  );
}

/** Campos que la fusión escribe en la parte canónica. */
export interface CanonicalUpdate {
  dui?: string;
  nrc?: string;
  seenAsEmisor?: boolean;
  seenAsReceptor?: boolean;
  defaultTipoOperacion?: number | null;
  defaultClasificacion?: number | null;
  defaultSector?: number | null;
  defaultTipoCostoGasto?: number | null;
}

/** Línea de atención sobre un grupo: se imprime y no detiene la fusión. */
export interface GroupNote {
  label: 'CONFLICTO' | 'AVISO';
  message: string;
  /** Filas `identificador : valor` que sustentan la nota. */
  detail: { identifier: string; value: string }[];
}

/** Todo lo que hace falta para fusionar un grupo, y para reportarlo. */
export interface GroupPlan {
  canonicalKey: string;
  canonical: PartyRow;
  /** Las hermanas, en el mismo orden en que se decide la canónica. */
  absorbed: PartyRow[];
  update: CanonicalUpdate;
  notes: GroupNote[];
  /** Documentos que cambian de parte. */
  reassigned: number;
  /** Documentos del contribuyente completo, ya fusionado. */
  totalDocuments: number;
}

/**
 * Orden de peso dentro del grupo: primero la que más documentos tiene; con
 * empate, la de `createdAt` más antiguo; con empate también ahí, por `id`.
 *
 * El tercer criterio no es decorativo: sin él, dos partes creadas en la misma
 * transacción (mismo `now()`) y con la misma cantidad de documentos harían que
 * la canónica dependiera del orden en que Postgres devolvió las filas, y dos
 * `--dry-run` seguidos podrían proponer fusiones distintas.
 */
function byWeight(a: PartyRow, b: PartyRow): number {
  const docs = documentCount(b) - documentCount(a);
  if (docs !== 0) return docs;

  const created = a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) return created;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * El identificador con el que se muestra una parte en el reporte: el `nit` tal
 * cual está guardado, que es el que el operador ve en la consulta del gate
 * (RUNBOOK §9.b) y en el mensaje de `PURCHASE_BOOK_SPLIT_RECEPTOR`.
 */
export function identifierOf(party: PartyRow): string {
  return party.nit;
}

/**
 * El DUI de 9 dígitos que aporta una parte, si tiene alguno.
 *
 * Mira `dui` y, si está vacío, el propio `nit`: hasta la migración
 * `20260910024854` el identificador de 9 dígitos vivía únicamente en `nit`, y
 * `splitSupplierId()` es la MISMA definición de "esto es un DUI" que usan la
 * ingesta y la regla E/P del anexo. No se inventa nada: se lee lo que ya está.
 */
function duiOf(party: PartyRow): string | null {
  if (party.dui !== null && party.dui.length > 0) return party.dui;
  return splitSupplierId(party.nit).dui || null;
}

/** El NRC normalizado que aporta una parte, si tiene alguno. */
function nrcOf(party: PartyRow): string | null {
  return party.nrc !== null && party.nrc.length > 0 ? party.nrc : null;
}

/**
 * Arma el plan de un grupo. Función pura: no consulta ni escribe nada, así que
 * el `--dry-run` y la corrida real reportan exactamente lo mismo.
 *
 * Reglas de consolidación (Addendum 11, §4, puntos 2 a 5):
 *
 * - **La canónica conserva su `nit`.** Nunca se sobrescribe un identificador ya
 *   presente. El `@@unique([tenantId, nit])` sigue vigente hasta el cierre de la
 *   fase, y de todos modos la identidad es la clave canónica: un contribuyente
 *   legítimamente tiene un NIT de 14 dígitos y un homologado al DUI de 9. Si el
 *   identificador de una absorbida no entra en ninguna columna libre, queda en
 *   el volcado que se imprime antes de borrarla, que es el registro que el
 *   addendum pide.
 * - **`dui` y `nrc` solo llenan huecos**, tomando el primer valor disponible en
 *   orden de peso.
 * - **Los flags se acumulan con OR**: una parte puede haber sido emisora en un
 *   documento y receptora en otro, y la fusión no puede perder ninguno de los
 *   dos roles.
 * - **Los defaults Q–T se toman como bloque, nunca columna por columna.** Los
 *   cuatro códigos son un criterio contable que alguien eligió junto; mezclar la
 *   Q de una parte con la R de otra produce una clasificación que no eligió
 *   nadie. Gana el bloque de la parte con más documentos —que es la canónica
 *   siempre que tenga alguno— y si hay más de un bloque distinto se reporta el
 *   conflicto para que el contador lo revise.
 */
export function planGroup(canonicalKey: string, parties: PartyRow[]): GroupPlan {
  const ordered = [...parties].sort(byWeight);
  const [canonical, ...absorbed] = ordered;

  const update: CanonicalUpdate = {};
  const notes: GroupNote[] = [];

  if (canonical.dui === null || canonical.dui.length === 0) {
    const dui = absorbed.map(duiOf).find((value): value is string => value !== null);
    if (dui !== undefined) update.dui = dui;
  }

  if (canonical.nrc === null || canonical.nrc.length === 0) {
    const nrc = absorbed.map(nrcOf).find((value): value is string => value !== null);
    if (nrc !== undefined) update.nrc = nrc;
  }

  if (!canonical.seenAsEmisor && absorbed.some((party) => party.seenAsEmisor)) {
    update.seenAsEmisor = true;
  }
  if (!canonical.seenAsReceptor && absorbed.some((party) => party.seenAsReceptor)) {
    update.seenAsReceptor = true;
  }

  // Bloques Q–T no vacíos, ya en orden de peso: el primero es el que gana.
  const blocks = ordered
    .map((party) => ({ party, block: defaultsOf(party) }))
    .filter((entry) => hasDefaults(entry.block));

  if (blocks.length > 0) {
    const winner = blocks[0];
    const losers = blocks.slice(1).filter((entry) => !sameDefaults(entry.block, winner.block));

    if (winner.party.id !== canonical.id) {
      // La canónica no tenía ningún default: adopta el bloque entero de la
      // hermana con más documentos que sí tenía. Se escriben las cuatro
      // columnas juntas, incluidas las nulas, para que quede el bloque tal cual
      // se decidió y no una mezcla.
      update.defaultTipoOperacion = winner.block.defaultTipoOperacion;
      update.defaultClasificacion = winner.block.defaultClasificacion;
      update.defaultSector = winner.block.defaultSector;
      update.defaultTipoCostoGasto = winner.block.defaultTipoCostoGasto;
    }

    if (losers.length > 0) {
      notes.push({
        label: 'CONFLICTO',
        message:
          'defaults Q–T distintos entre las partes; gana ' +
          `${identifierOf(winner.party)} (${documentCount(winner.party)} documentos) ` +
          'y el resto se descarta. Revisar la clasificación del receptor.',
        detail: [winner, ...losers].map((entry) => ({
          identifier: identifierOf(entry.party),
          value: renderDefaults(entry.block),
        })),
      });
    }
  }

  // El nombre no participa de la fusión, pero es la única evidencia visible de
  // que las dos filas son la misma persona. El addendum (§5) confía la decisión
  // al operador: si los nombres no coinciden, tiene que poder verlo antes de
  // aplicar, no después de borrar.
  const names = new Set(ordered.map((party) => party.nombre));
  if (names.size > 1) {
    notes.push({
      label: 'AVISO',
      message:
        'los nombres no coinciden entre las partes; confirmar que son el mismo contribuyente',
      detail: ordered.map((party) => ({
        identifier: identifierOf(party),
        value: party.nombre,
      })),
    });
  }

  const reassigned = absorbed.reduce((sum, party) => sum + documentCount(party), 0);

  return {
    canonicalKey,
    canonical,
    absorbed,
    update,
    notes,
    reassigned,
    totalDocuments: reassigned + documentCount(canonical),
  };
}

/**
 * De qué rama de la cascada (§2) salió la clave, para rotularla en el reporte.
 * Es informativo: la clave ya está calculada en la base, esto solo la explica.
 */
export function canonicalKeyLabel(canonicalKey: string, parties: PartyRow[]): string {
  const fromNrc = parties.some(
    (party) => stripLeadingZeros(onlyDigits(party.nrc)) === canonicalKey,
  );
  if (fromNrc) return 'nrc';
  if (canonicalKey.length === 14) return 'nit';
  if (canonicalKey.length === 9) return 'dui';
  return 'clave';
}

/**
 * Lo que la fusión necesita de la infraestructura. Existe para poder probar la
 * elección de la canónica, la consolidación y el aislamiento de fallos sin una
 * base viva.
 */
export interface MergePort {
  /**
   * Grupos con más de una parte del tenant, ya scopeados con el contexto de
   * tenant (RLS). Cada entrada es `[canonicalKey, partes]`.
   */
  listGroups(tenantId: string): Promise<[string, PartyRow[]][]>;
  /** Aplica un plan dentro de UNA transacción. Solo se llama con --apply. */
  applyPlan(tenantId: string, plan: GroupPlan): Promise<void>;
}

export interface GroupOutcome {
  plan: GroupPlan;
  /** Mensaje del fallo de ESTE grupo. Los demás grupos siguen. */
  error?: string;
}

export interface TenantOutcome {
  slug: string;
  groups: GroupOutcome[];
  /** Fallo al enumerar los grupos: el tenant entero queda sin procesar. */
  error?: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recorre los tenants uno por uno y, dentro de cada uno, los grupos uno por
 * uno. Dos aislamientos independientes:
 *
 * - **Un grupo que falla no arrastra a los demás**: cada fusión es su propia
 *   transacción, así que un grupo que revienta deja al resto del tenant intacto
 *   y sin fusionar a medias.
 * - **Un tenant que falla no aborta la corrida**: queda marcado en su fila y el
 *   proceso sigue con el siguiente (misma regla que un correo que falla dentro
 *   de un sync).
 *
 * `onGroup` y `onTenantError` se llaman a medida que la corrida avanza, no al
 * final: una interrupción (Ctrl-C, caída del SSH) no puede borrar el registro de
 * lo que ya se fusionó, que es justamente lo que no se puede reconstruir.
 */
export async function mergeTenants(
  tenants: TenantRow[],
  options: MergeOptions,
  port: MergePort,
  hooks: {
    onGroup?: (slug: string, outcome: GroupOutcome) => void;
    onTenantError?: (slug: string, error: string) => void;
  } = {},
): Promise<TenantOutcome[]> {
  const outcomes: TenantOutcome[] = [];

  for (const tenant of tenants) {
    // A diferencia del backfill, los tenants no ACTIVOS NO se omiten: la fusión
    // es una corrección de integridad de datos que ya están escritos, y el
    // `@@unique([tenantId, canonicalKey])` que cierra la fase se aplica a todas
    // las filas de la tabla. Saltear un tenant suspendido dejaría duplicados que
    // harían fallar esa migración.
    let groups: [string, PartyRow[]][];
    try {
      groups = await port.listGroups(tenant.id);
    } catch (err: unknown) {
      const error = describeError(err);
      outcomes.push({ slug: tenant.slug, groups: [], error });
      hooks.onTenantError?.(tenant.slug, error);
      continue;
    }

    const groupOutcomes: GroupOutcome[] = [];

    for (const [canonicalKey, parties] of groups) {
      const plan = planGroup(canonicalKey, parties);
      let outcome: GroupOutcome = { plan };

      if (options.apply) {
        try {
          await port.applyPlan(tenant.id, plan);
        } catch (err: unknown) {
          outcome = { plan, error: describeError(err) };
        }
      }

      groupOutcomes.push(outcome);
      hooks.onGroup?.(tenant.slug, outcome);
    }

    outcomes.push({ slug: tenant.slug, groups: groupOutcomes });
  }

  return outcomes;
}

/**
 * 16799 -> "16.799". Separador de miles fijo, sin depender del ICU del host.
 * Misma función que en `backfill-purchase-book.ts`; se repite en vez de
 * importarse porque ese módulo arrastra el contexto de Nest y la cola BullMQ, y
 * esta herramienta no toca Redis.
 */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function plural(count: number, singular: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : many}`;
}

/** Sangría de las filas de detalle de una nota o de un volcado. */
const DETAIL_INDENT = ' '.repeat(16);

/** Ancho de la etiqueta `canónica` / `absorbe`, que el §4 fija en 8. */
const LABEL_WIDTH = 8;

/** Ancho de la etiqueta de las notas (`CONFLICTO` es la más larga). */
const NOTE_LABEL_WIDTH = 9;

/** Formatea un valor de columna para el volcado de la parte borrada. */
export function formatDumpValue(value: unknown): string {
  if (value === null || value === undefined) return '(vacío)';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value.length === 0 ? '(vacío)' : value;
  return JSON.stringify(value);
}

/**
 * Volcado completo de una parte antes de borrarla (§4, punto 6). Es el único
 * registro que queda de una fila que se va: se imprime SIEMPRE que se borre, y
 * por eso solo aparece con `--apply` — el `--dry-run` no borra nada.
 */
export function renderPartyDump(party: PartyRow): string[] {
  // El cast es a `Record<string, unknown>`, no a `any`: `Object.entries` sobre
  // un tipo sin índice devuelve `[string, any][]` y eso sí violaría la regla 2
  // de CLAUDE.md.
  const entries = Object.entries(party as Record<string, unknown>).filter(
    ([key]) => key !== 'documentsAsEmisor' && key !== 'documentsAsReceptor',
  );
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);

  return [
    ...entries.map(
      ([key, value]) => `${DETAIL_INDENT}${key.padEnd(width)} : ${formatDumpValue(value)}`,
    ),
    `${DETAIL_INDENT}${'documentos'.padEnd(width)} : ${formatCount(documentCount(party))}` +
      ` (emisor ${formatCount(party.documentsAsEmisor)},` +
      ` receptor ${formatCount(party.documentsAsReceptor)})`,
  ];
}

/**
 * Bloque de un grupo, tal como lo dibuja el §4 del addendum:
 *
 * ```
 *     JOSE WALTER CRUZ MARAVILLA  nrc 1435153
 *       canónica : 11022205761034  (849 documentos)
 *       absorbe  : 022560911       (7 documentos)   -> 856 tras fusionar
 * ```
 *
 * Las dos columnas se alinean contra el grupo, no contra la corrida entera: las
 * filas se imprimen a medida que avanza y en ese momento no se conocen los
 * anchos de los grupos que faltan.
 */
export function renderGroup(outcome: GroupOutcome, apply: boolean): string[] {
  const { plan } = outcome;
  const all = [plan.canonical, ...plan.absorbed];

  const idWidth = all.reduce((max, party) => Math.max(max, identifierOf(party).length), 0);
  const countCell = (party: PartyRow): string =>
    `(${plural(documentCount(party), 'documento', 'documentos')})`;
  const countWidth = all.reduce((max, party) => Math.max(max, countCell(party).length), 0);

  const row = (label: string, party: PartyRow, tail = ''): string =>
    `      ${label.padEnd(LABEL_WIDTH)} : ${identifierOf(party).padEnd(idWidth + 2)}` +
    `${tail.length > 0 ? countCell(party).padEnd(countWidth + 1) + tail : countCell(party)}`;

  const lines = [
    `    ${plan.canonical.nombre}  ${canonicalKeyLabel(plan.canonicalKey, all)} ${plan.canonicalKey}`,
    row('canónica', plan.canonical),
    ...plan.absorbed.map((party, index) =>
      row(
        'absorbe',
        party,
        // El total fusionado cierra el grupo: va en la última hermana.
        index === plan.absorbed.length - 1
          ? `-> ${formatCount(plan.totalDocuments)} tras fusionar`
          : '',
      ),
    ),
  ];

  for (const note of plan.notes) {
    const width = note.detail.reduce((max, item) => Math.max(max, item.identifier.length), 0);
    lines.push(`      ${note.label.padEnd(NOTE_LABEL_WIDTH)} ${note.message}`);
    lines.push(
      ...note.detail.map(
        (item) => `${DETAIL_INDENT}${item.identifier.padEnd(width)} : ${item.value}`,
      ),
    );
  }

  if (outcome.error !== undefined) {
    // El grupo entero se revirtió con su transacción: no quedó fusionado a
    // medias. Los demás grupos del tenant sí se procesaron.
    lines.push(
      `      ${'ERROR'.padEnd(NOTE_LABEL_WIDTH)} el grupo no se fusionó (sin cambios): ${outcome.error}`,
    );
    return lines;
  }

  if (apply) {
    for (const party of plan.absorbed) {
      lines.push(
        `      ${'BORRADA'.padEnd(NOTE_LABEL_WIDTH)} ${identifierOf(party)} (id ${party.id})` +
          ' — contenido completo antes de borrarla',
      );
      lines.push(...renderPartyDump(party));
    }
  }

  return lines;
}

/** Fila del tenant que no se pudo enumerar. */
export function renderTenantError(slug: string, error: string): string {
  return `  tenant ${slug}  ERROR: ${error}`;
}

/** Encabezado de un tenant. Solo se imprime si el tenant tiene algo que decir. */
export function renderTenantHeader(slug: string): string {
  return `  tenant ${slug}`;
}

/** Ancho de la línea de cierre, fijado por el §4 del addendum. */
const SEPARATOR = `  ${'-'.repeat(66)}`;

/**
 * Cierre del reporte.
 *
 * Los verbos van en pasado en los dos modos ("documentos reasignados"), tal
 * como lo dibuja el §4: el encabezado de la corrida ya dice si se aplicó o no,
 * y repetirlo acá haría que el reporte del ensayo no se pudiera comparar línea
 * a línea con el de la corrida real.
 */
export function renderSummary(outcomes: TenantOutcome[]): string {
  const withGroups = outcomes.filter((outcome) => outcome.groups.length > 0);
  const groups = withGroups.flatMap((outcome) => outcome.groups);
  const failed =
    outcomes.filter((outcome) => outcome.error).length +
    groups.filter((group) => group.error).length;

  const totals =
    `  ${plural(withGroups.length, 'tenant', 'tenants')}, ` +
    `${plural(groups.length, 'grupo', 'grupos')}, ` +
    `${formatCount(groups.reduce((sum, group) => sum + group.plan.absorbed.length + 1, 0))} partes` +
    ` -> ${formatCount(groups.length)}, ` +
    `${plural(
      groups.reduce((sum, group) => sum + group.plan.reassigned, 0),
      'documento reasignado',
      'documentos reasignados',
    )}`;

  if (groups.length === 0 && failed === 0) {
    return ['  (no hay partes para fusionar)', '', totals].join('\n');
  }

  const lines = [SEPARATOR, totals];
  if (failed > 0) {
    lines.push(
      `  ${formatCount(failed)} fusión(es) o tenant(s) con error: revisar las filas de arriba.`,
    );
  }

  return lines.join('\n');
}

/** Encabezado de la corrida. */
export function renderHeader(options: MergeOptions): string {
  const mode = options.apply
    ? '--apply (la fusión se escribe en la base)'
    : '--dry-run (no se aplica nada)';
  const tenant = options.tenant ? `tenant ${options.tenant}, ` : '';
  return `Fusión de partes por identidad canónica — ${tenant}${mode}`;
}

/**
 * Reporte completo. La corrida real imprime a medida que avanza; esto arma lo
 * mismo de una sola vez y es la definición del formato.
 */
export function renderReport(outcomes: TenantOutcome[], options: MergeOptions): string {
  const lines: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      lines.push(renderTenantError(outcome.slug, outcome.error));
      continue;
    }
    if (outcome.groups.length === 0) continue;

    lines.push(renderTenantHeader(outcome.slug));
    for (const group of outcome.groups) {
      lines.push(...renderGroup(group, options.apply));
    }
  }

  return [...lines, renderSummary(outcomes)].join('\n');
}

function createPort(prisma: PrismaService): MergePort {
  return {
    listGroups: (tenantId) =>
      // `dte_parties` tiene RLS con FORCE: sin `withTenant` (SET LOCAL de
      // app.tenant_id) el rol maildte_app ve 0 filas y el script reportaría
      // "no hay partes para fusionar" sin ningún error visible.
      prisma.withTenant(tenantId, async (tx) => {
        // Primero las claves duplicadas, y recién después las filas: así no se
        // trae a memoria el padrón completo de proveedores de un tenant para
        // descartar casi todo. Las partes sin clave canónica quedan afuera a
        // propósito — no se les inventa una identidad (§2).
        const duplicated = await tx.dteParty.groupBy({
          by: ['canonicalKey'],
          where: { tenantId, canonicalKey: { not: null } },
          _count: { _all: true },
          having: { canonicalKey: { _count: { gt: 1 } } },
        });

        const keys = duplicated
          .map((row) => row.canonicalKey)
          .filter((key): key is string => key !== null);
        if (keys.length === 0) return [];

        const parties = await tx.dteParty.findMany({
          where: { tenantId, canonicalKey: { in: keys } },
          include: { _count: { select: { emisorDocuments: true, receptorDocuments: true } } },
        });

        const grouped = new Map<string, PartyRow[]>();
        for (const { _count, ...party } of parties) {
          // El `in` de arriba garantiza la clave; el guard es para el tipo.
          if (party.canonicalKey === null) continue;
          const row: PartyRow = {
            ...party,
            documentsAsEmisor: _count.emisorDocuments,
            documentsAsReceptor: _count.receptorDocuments,
          };
          const bucket = grouped.get(party.canonicalKey);
          if (bucket === undefined) grouped.set(party.canonicalKey, [row]);
          else bucket.push(row);
        }

        // Orden estable del reporte: el grupo más grande primero, igual que la
        // consulta del gate del RUNBOOK §9.b.
        return [...grouped.entries()]
          .filter(([, rows]) => rows.length > 1)
          .sort(([keyA, a], [keyB, b]) => b.length - a.length || keyA.localeCompare(keyB));
      }),

    applyPlan: (tenantId, plan) =>
      // `withTenant` ES una transacción: una por grupo, tal como pide el §4. Un
      // grupo que revienta a mitad no deja documentos reasignados a una parte
      // que después no se borró.
      prisma.withTenant(tenantId, async (tx) => {
        const absorbedIds = plan.absorbed.map((party) => party.id);

        // Los dos roles: el mismo contribuyente puede haber quedado partido
        // también del lado emisor.
        await tx.purchaseDocument.updateMany({
          where: { tenantId, receptorId: { in: absorbedIds } },
          data: { receptorId: plan.canonical.id },
        });
        await tx.purchaseDocument.updateMany({
          where: { tenantId, emisorId: { in: absorbedIds } },
          data: { emisorId: plan.canonical.id },
        });

        if (Object.keys(plan.update).length > 0) {
          await tx.dteParty.update({ where: { id: plan.canonical.id }, data: plan.update });
        }

        // Recién acá, con las FK ya apuntando a la canónica.
        await tx.dteParty.deleteMany({ where: { tenantId, id: { in: absorbedIds } } });
      }),
  };
}

/**
 * `tenants` es la única tabla de negocio SIN RLS (ver la migración
 * multi_tenancy): el rol de aplicación puede enumerarla sin contexto de tenant,
 * que es justamente lo que este script necesita para arrancar.
 */
async function loadTenants(prisma: PrismaService, ref?: string): Promise<TenantRow[]> {
  const select = { id: true, slug: true } as const;

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

  const app = await NestFactory.createApplicationContext(MergePartiesModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);

    const tenants = await loadTenants(prisma, options.tenant);
    if (options.tenant && tenants.length === 0) {
      console.error(`No existe ningún tenant con slug o id "${options.tenant}".`);
      process.exitCode = 1;
      return;
    }

    console.log(renderHeader(options));
    console.log('');

    // A medida que avanza, no al final: una fusión aplicada no se puede
    // reconstruir, así que el volcado de las partes borradas tiene que estar en
    // pantalla antes de que la corrida siga con el grupo siguiente.
    let printedTenant: string | undefined;
    const outcomes = await mergeTenants(tenants, options, createPort(prisma), {
      onGroup: (slug, outcome) => {
        if (printedTenant !== slug) {
          console.log(renderTenantHeader(slug));
          printedTenant = slug;
        }
        for (const line of renderGroup(outcome, options.apply)) console.log(line);
      },
      onTenantError: (slug, error) => {
        console.log(renderTenantError(slug, error));
        printedTenant = undefined;
      },
    });

    console.log(renderSummary(outcomes));

    const failed = outcomes.some(
      (outcome) => outcome.error !== undefined || outcome.groups.some((group) => group.error),
    );
    if (failed) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

// Solo al ejecutarlo como script. Sin la guarda, importarlo desde el test
// arrancaría un contexto de Nest contra la base real.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Error inesperado en la fusión de partes:', err);
    process.exitCode = 1;
  });
}
