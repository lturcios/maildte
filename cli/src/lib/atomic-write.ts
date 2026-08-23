import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export async function writeFileAtomic(
  finalPath: string,
  content: Buffer | Readable,
): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  if (Buffer.isBuffer(content)) {
    await writeFile(tmpPath, content);
  } else {
    await pipeline(content, createWriteStream(tmpPath));
  }
  await rename(tmpPath, finalPath);
}
