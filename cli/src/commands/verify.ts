import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config';
import { ApiClient } from '../lib/api-client';
import { sha256File } from '../lib/hash';
import { CommandOptions } from './init';
import { localRelativePath } from './sync';

export interface VerifyOptions extends CommandOptions {
  account?: string;
  stripTenantPrefix: boolean;
}

export function parseVerifyArgs(argv: string[]): Omit<VerifyOptions, 'cwd'> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      'strip-tenant-prefix': { type: 'boolean', default: true },
      'no-strip-tenant-prefix': { type: 'boolean', default: false },
    },
    strict: true,
  });
  return {
    account: values.account as string | undefined,
    stripTenantPrefix: !(values['no-strip-tenant-prefix'] as boolean),
  };
}

export async function runVerify(argv: string[], options: CommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const verifyOptions = parseVerifyArgs(argv);

  const config = loadConfig(cwd);
  const destDir = join(cwd, config.destDir);
  const client = new ApiClient(config.apiUrl, config.apiKey);

  const accounts = config.accounts.filter(
    (a) =>
      !verifyOptions.account || a.email === verifyOptions.account || a.alias === verifyOptions.account,
  );

  let totalOk = 0;
  let totalFaltantes = 0;
  let totalCorruptos = 0;

  for (const account of accounts) {
    let ok = 0;
    let faltantes = 0;
    let corruptos = 0;

    for await (const { entries } of client.fetchFullManifest({ accountId: account.id })) {
      for (const entry of entries) {
        if (entry.missing) continue; // el servidor ya sabe que no lo tiene: no es un problema del cliente
        const localPath = join(
          destDir,
          localRelativePath(entry.relativePath, verifyOptions.stripTenantPrefix),
        );
        if (!existsSync(localPath)) {
          faltantes++;
          console.error(`  Faltante: ${entry.relativePath}`);
          continue;
        }
        const actualHash = await sha256File(localPath);
        if (actualHash !== entry.sha256) {
          corruptos++;
          console.error(`  Corrupto: ${entry.relativePath}`);
          continue;
        }
        ok++;
      }
    }

    console.log(`\nCuenta: ${account.alias} (${account.email})`);
    console.log(`  OK: ${ok} | Faltantes: ${faltantes} | Corruptos: ${corruptos}`);

    totalOk += ok;
    totalFaltantes += faltantes;
    totalCorruptos += corruptos;
  }

  console.log('\nResumen de verificación:');
  console.log(`  OK: ${totalOk} | Faltantes: ${totalFaltantes} | Corruptos: ${totalCorruptos}`);

  process.exitCode = totalFaltantes + totalCorruptos > 0 ? 1 : 0;
}
