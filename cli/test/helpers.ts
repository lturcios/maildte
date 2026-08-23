import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_FILENAME } from '../src/lib/config';
import { CliConfig } from '../src/lib/types';

export function makeTempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'maildte-pull-test-'));
}

export function writeTestConfig(cwd: string, config: CliConfig): void {
  writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify(config, null, 2), 'utf8');
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function captureExitCode(fn: () => Promise<void>): Promise<number> {
  process.exitCode = undefined;
  await fn();
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return code;
}

export function captureConsole(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(' '));
  };
  return {
    errors,
    restore: (): void => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}
