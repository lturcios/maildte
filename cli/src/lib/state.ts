import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write';
import { StateFile } from './types';

export const STATE_FILENAME = '.maildte-state.json';

export function statePath(destDir: string): string {
  return join(destDir, STATE_FILENAME);
}

export function loadState(destDir: string): StateFile {
  const path = statePath(destDir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as StateFile;
}

export async function saveState(destDir: string, state: StateFile): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await writeFileAtomic(
    statePath(destDir),
    Buffer.from(JSON.stringify(state, null, 2), 'utf8'),
  );
}
