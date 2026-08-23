import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliConfig } from './types';

export const CONFIG_FILENAME = 'maildte.config.json';

export function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILENAME);
}

export function loadConfig(cwd: string): CliConfig {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      `No se encontró ${CONFIG_FILENAME} en ${cwd}. Corré "maildte-pull init" primero.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
}

export function saveConfig(config: CliConfig, cwd: string): void {
  const path = configPath(cwd);
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  try {
    // el archivo contiene la API key; en Windows chmod es best-effort (usa ACLs, no bits unix)
    chmodSync(path, 0o600);
  } catch {
    // no bloquea init si el filesystem no soporta chmod
  }
}
