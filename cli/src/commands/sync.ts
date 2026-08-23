import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { loadConfig } from '../lib/config';
import { loadState, saveState } from '../lib/state';
import { ApiClient } from '../lib/api-client';
import { runWithConcurrency } from '../lib/concurrency';
import { writeFileAtomic } from '../lib/atomic-write';
import { sha256File } from '../lib/hash';
import { decideStrategy, groupByMonth } from '../lib/strategy';
import { AccountSyncResult, printAccountResult, printSummary } from '../lib/logger';
import { AccountConfig, ManifestEntry } from '../lib/types';
import { CommandOptions } from './init';

const CONCURRENCY = 4;
const MAX_RETRIES = 3;

export interface SyncOptions extends CommandOptions {
  all: boolean;
  account?: string;
  month?: string;
  dryRun: boolean;
  stripTenantPrefix: boolean;
}

export function parseSyncArgs(argv: string[]): Omit<SyncOptions, 'cwd'> {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean', default: false },
      account: { type: 'string' },
      month: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      // --strip-tenant-prefix está activado por default (RF-07 addendum multi-tenant):
      // el servidor persiste relativePath como {tenantSlug}/{cuenta}/..., pero el cliente
      // no necesita ni quiere ese slug como carpeta raíz local. --no-strip-tenant-prefix
      // lo desactiva para quien sí quiera replicar la estructura exacta del servidor.
      'strip-tenant-prefix': { type: 'boolean', default: true },
      'no-strip-tenant-prefix': { type: 'boolean', default: false },
    },
    strict: true,
  });
  return {
    all: values.all as boolean,
    account: values.account as string | undefined,
    month: values.month as string | undefined,
    dryRun: values['dry-run'] as boolean,
    stripTenantPrefix: !(values['no-strip-tenant-prefix'] as boolean),
  };
}

/** Omite el primer segmento (tenantSlug) de un relativePath del servidor, si corresponde. */
export function localRelativePath(relativePath: string, stripTenantPrefix: boolean): string {
  if (!stripTenantPrefix) return relativePath;
  const segments = relativePath.split('/');
  return segments.slice(1).join('/');
}

export async function runSync(argv: string[], options: CommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const syncOptions = parseSyncArgs(argv);

  const config = loadConfig(cwd);
  const destDir = join(cwd, config.destDir);
  const state = loadState(destDir);
  const client = new ApiClient(config.apiUrl, config.apiKey);

  const accounts = config.accounts.filter(
    (a) => !syncOptions.account || a.email === syncOptions.account || a.alias === syncOptions.account,
  );
  if (accounts.length === 0) {
    console.error(`No hay cuentas configuradas que coincidan con "${syncOptions.account}".`);
    process.exitCode = 1;
    return;
  }

  const results: AccountSyncResult[] = [];
  let hadFailures = false;

  for (const account of accounts) {
    const since = syncOptions.all ? undefined : (state[account.id]?.cursor ?? undefined);

    const entries: ManifestEntry[] = [];
    let maxCreatedAt: string | null = null;
    for await (const { page, entries: pageEntries } of client.fetchFullManifest({
      accountId: account.id,
      since,
      month: syncOptions.month,
    })) {
      entries.push(...pageEntries);
      if (page.meta.maxCreatedAt) maxCreatedAt = page.meta.maxCreatedAt;
    }

    const available = entries.filter((e) => !e.missing);
    const missingOnServer = entries.length - available.length;

    const pending: ManifestEntry[] = [];
    let yaExistentes = 0;
    for (const entry of available) {
      const localPath = join(
        destDir,
        localRelativePath(entry.relativePath, syncOptions.stripTenantPrefix),
      );
      if (existsSync(localPath) && (await sha256File(localPath)) === entry.sha256) {
        yaExistentes++;
        continue;
      }
      pending.push(entry);
    }

    if (syncOptions.dryRun) {
      console.log(`\n[dry-run] Cuenta: ${account.alias} (${account.email})`);
      console.log(
        `  Se descargarían ${pending.length} archivo(s) (${yaExistentes} ya existen con hash válido).`,
      );
      continue;
    }

    const strategy = decideStrategy(pending.length, syncOptions.all);
    const { descargados, fallidos, bytes } = await downloadPending(
      client,
      destDir,
      pending,
      strategy,
      account,
      since,
      syncOptions.month,
      syncOptions.stripTenantPrefix,
    );

    hadFailures = hadFailures || fallidos > 0;

    // El cursor SOLO avanza si TODO el lote quedó verificado (RF-07.7).
    if (fallidos === 0 && maxCreatedAt) {
      state[account.id] = { cursor: maxCreatedAt };
      await saveState(destDir, state);
    }

    const result: AccountSyncResult = {
      accountLabel: `${account.alias} (${account.email})`,
      nuevos: pending.length,
      yaExistentes,
      descargados,
      fallidos,
      bytes,
      estrategia:
        strategy === 'zip' ? 'ZIP por mes' : `descargas individuales (concurrencia ${CONCURRENCY})`,
    };
    results.push(result);
    printAccountResult(result);

    if (missingOnServer > 0) {
      console.log(
        `  Nota: ${missingOnServer} archivo(s) registrados en el servidor ya no están disponibles.`,
      );
    }
  }

  if (!syncOptions.dryRun) {
    printSummary(results);
  }

  process.exitCode = hadFailures ? 1 : 0;
}

async function downloadPending(
  client: ApiClient,
  destDir: string,
  pending: ManifestEntry[],
  strategy: 'individual' | 'zip',
  account: AccountConfig,
  since: string | undefined,
  monthFilter: string | undefined,
  stripTenantPrefix: boolean,
): Promise<{ descargados: number; fallidos: number; bytes: number }> {
  if (pending.length === 0) return { descargados: 0, fallidos: 0, bytes: 0 };

  if (strategy === 'individual') {
    return downloadIndividually(client, destDir, pending, stripTenantPrefix);
  }
  return downloadViaZip(client, destDir, pending, account.id, since, monthFilter, stripTenantPrefix);
}

async function downloadIndividually(
  client: ApiClient,
  destDir: string,
  pending: ManifestEntry[],
  stripTenantPrefix: boolean,
): Promise<{ descargados: number; fallidos: number; bytes: number }> {
  let descargados = 0;
  let fallidos = 0;
  let bytes = 0;

  await runWithConcurrency(pending, CONCURRENCY, async (entry) => {
    const localPath = join(destDir, localRelativePath(entry.relativePath, stripTenantPrefix));
    let verified = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES && !verified; attempt++) {
      try {
        const stream = await client.downloadAttachment(entry.attachmentId);
        await writeFileAtomic(localPath, stream);
        const actualHash = await sha256File(localPath);
        if (actualHash === entry.sha256) {
          verified = true;
        } else {
          lastError = new Error(
            `hash no coincide (esperado ${entry.sha256}, obtenido ${actualHash})`,
          );
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (verified) {
      descargados++;
      bytes += entry.sizeBytes;
    } else {
      fallidos++;
      console.error(
        `  Error: ${entry.relativePath} no se pudo verificar tras ${MAX_RETRIES} intentos ` +
          `(${lastError instanceof Error ? lastError.message : String(lastError)})`,
      );
    }
  });

  return { descargados, fallidos, bytes };
}

async function downloadViaZip(
  client: ApiClient,
  destDir: string,
  pending: ManifestEntry[],
  accountId: string,
  since: string | undefined,
  monthFilter: string | undefined,
  stripTenantPrefix: boolean,
): Promise<{ descargados: number; fallidos: number; bytes: number }> {
  const months = monthFilter ? new Map([[monthFilter, pending]]) : groupByMonth(pending);
  let descargados = 0;
  let fallidos = 0;
  let bytes = 0;

  for (const [month, monthEntries] of months) {
    const remaining = new Map(monthEntries.map((e) => [e.relativePath, e]));

    for (let attempt = 1; attempt <= MAX_RETRIES && remaining.size > 0; attempt++) {
      try {
        const stream = await client.downloadArchive({ accountId, since, month });
        const buffer = await streamToBuffer(stream);
        const directory = await unzipper.Open.buffer(buffer);

        for (const file of directory.files) {
          if (file.type !== 'File' || file.path === 'manifest.json') continue;
          const expectedEntry = remaining.get(file.path);
          if (!expectedEntry) continue;

          const localPath = join(destDir, localRelativePath(file.path, stripTenantPrefix));
          const content = await file.buffer();
          await writeFileAtomic(localPath, content);
          const actualHash = await sha256File(localPath);
          if (actualHash === expectedEntry.sha256) {
            descargados++;
            bytes += expectedEntry.sizeBytes;
            remaining.delete(file.path);
          }
          // si no coincide, se queda en "remaining" para el próximo intento
        }
      } catch {
        // fallo de red/servidor en este intento: se reintenta el mes completo
      }
    }

    for (const [path] of remaining) {
      fallidos++;
      console.error(`  Error: ${path} no se pudo verificar tras ${MAX_RETRIES} intentos (vía ZIP)`);
    }
  }

  return { descargados, fallidos, bytes };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
