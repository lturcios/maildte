import { BadRequestException, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'fs/promises';
import { basename, extname, join, posix, resolve, sep } from 'path';
import { Readable, Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { AppConfigService } from '../config/app-config.service';
import { sanitizeFilename } from '../common/utils/sanitize-filename';

export type AttachmentFileType = 'json' | 'pdf';

export interface SaveAttachmentParams {
  content: Buffer | Readable;
  account: { folderName: string };
  monthFolder: string;
  originalName: string;
  mimeType: string;
}

export interface SavedAttachment {
  storedName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  reused: boolean;
}

function determineFileType(filename: string, mimeType: string): AttachmentFileType {
  return /\.json$/i.test(filename) || mimeType === 'application/json' ? 'json' : 'pdf';
}

function withHashSuffix(sanitizedName: string, sha256: string): string {
  const ext = extname(sanitizedName);
  const base = basename(sanitizedName, ext);
  return `${base}_${sha256.slice(0, 8)}${ext}`;
}

/** Pasa los chunks sin modificar mientras acumula el sha256 (hash "al vuelo" para streams grandes). */
class HashingPassthrough extends Transform {
  private readonly hash = createHash('sha256');
  private size = 0;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }

  get bytesWritten(): number {
    return this.size;
  }
}

@Injectable()
export class StorageService {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StorageService.name);
  }

  /**
   * Todo path se valida dentro de STORAGE_ROOT/{tenantSlug}, no solo STORAGE_ROOT (skill
   * tenancy, regla 12): un relativePath de otro tenant es traversal aunque técnicamente
   * caiga dentro de STORAGE_ROOT. tenantSlug siempre sale del TenantContext autenticado,
   * nunca del propio relativePath (que podría venir de una fila manipulada en BD).
   */
  resolveSafe(tenantSlug: string, relativePath: string): string {
    const root = resolve(this.config.storageRoot);
    const tenantRoot = resolve(root, tenantSlug);
    const resolved = resolve(root, relativePath);
    if (resolved !== tenantRoot && !resolved.startsWith(tenantRoot + sep)) {
      throw new BadRequestException({
        error: 'INVALID_STORAGE_PATH',
        message: 'Ruta fuera del área de almacenamiento',
      });
    }
    return resolved;
  }

  async ensureAccountFolder(tenantSlug: string, folderName: string): Promise<void> {
    const target = this.resolveSafe(tenantSlug, posix.join(tenantSlug, folderName));
    await mkdir(target, { recursive: true });
  }

  /** Único punto de conversión de TZ del sistema. No duplicar esta lógica en ningún otro archivo. */
  resolveMonthFolder(receivedAt: Date): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.tzFolder,
      year: 'numeric',
      month: '2-digit',
    });
    const parts = fmt.formatToParts(receivedAt);
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    return `${y}-${m}`;
  }

  async saveAttachment(tenantSlug: string, params: SaveAttachmentParams): Promise<SavedAttachment> {
    const { content, account, monthFolder, originalName, mimeType } = params;

    const fileType = determineFileType(originalName, mimeType);
    const sanitized = sanitizeFilename(originalName);
    // relativePath incluye el tenantSlug como primer segmento (skill tenancy, regla 13):
    // consistencia BD <-> disco, y es lo que resolveSafe valida contra el contexto.
    const dirRelative = posix.join(tenantSlug, account.folderName, monthFolder, fileType);
    const dirAbsolute = this.resolveSafe(tenantSlug, dirRelative);
    await mkdir(dirAbsolute, { recursive: true });

    const primaryAbsolute = join(dirAbsolute, sanitized);
    const tmpPath = `${primaryAbsolute}.tmp`;
    const { sha256, sizeBytes } = await this.writeAtomic(tmpPath, content);

    const existingHash = await this.hashIfExists(primaryAbsolute);
    if (existingHash === sha256) {
      await rm(tmpPath, { force: true });
      return this.describeExisting(dirRelative, dirAbsolute, sanitized, sha256);
    }

    if (existingHash === null) {
      await rename(tmpPath, primaryAbsolute);
      return {
        storedName: sanitized,
        relativePath: posix.join(dirRelative, sanitized),
        sizeBytes,
        sha256,
        reused: false,
      };
    }

    // Colisión: mismo nombre, contenido distinto (RF-04.4).
    const suffixed = withHashSuffix(sanitized, sha256);
    const suffixedAbsolute = join(dirAbsolute, suffixed);
    const suffixedExistingHash = await this.hashIfExists(suffixedAbsolute);

    if (suffixedExistingHash === sha256) {
      await rm(tmpPath, { force: true });
      return this.describeExisting(dirRelative, dirAbsolute, suffixed, sha256);
    }
    if (suffixedExistingHash !== null) {
      await rm(tmpPath, { force: true });
      throw new Error(`Colisión de SHA-256 inesperada al guardar ${suffixedAbsolute}`);
    }

    await rename(tmpPath, suffixedAbsolute);
    return {
      storedName: suffixed,
      relativePath: posix.join(dirRelative, suffixed),
      sizeBytes,
      sha256,
      reused: false,
    };
  }

  /** Borra `**\/*.tmp` de la carpeta de la cuenta (restos de caídas). Se llama al iniciar cada sync. */
  async cleanOrphanTmp(tenantSlug: string, folderName: string): Promise<void> {
    const root = this.resolveSafe(tenantSlug, posix.join(tenantSlug, folderName));
    await this.removeTmpFilesRecursively(root);
  }

  /**
   * Rollback en disco: borra en best-effort los archivos escritos de UN correo cuando
   * su transacción de BD falla. El llamador nunca debe incluir archivos con reused: true.
   */
  async deleteFiles(tenantSlug: string, relativePaths: string[]): Promise<void> {
    await Promise.all(
      relativePaths.map((relativePath) => this.deleteOne(tenantSlug, relativePath)),
    );
  }

  private async deleteOne(tenantSlug: string, relativePath: string): Promise<void> {
    const absolute = this.resolveSafe(tenantSlug, relativePath);
    try {
      await unlink(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.logger.error(
        { err, relativePath },
        'No se pudo borrar el archivo en el rollback de storage',
      );
    }
  }

  private async describeExisting(
    dirRelative: string,
    dirAbsolute: string,
    storedName: string,
    sha256: string,
  ): Promise<SavedAttachment> {
    const info = await stat(join(dirAbsolute, storedName));
    return {
      storedName,
      relativePath: posix.join(dirRelative, storedName),
      sizeBytes: info.size,
      sha256,
      reused: true,
    };
  }

  private async writeAtomic(
    tmpPath: string,
    content: Buffer | Readable,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    if (Buffer.isBuffer(content)) {
      const fh = await open(tmpPath, 'w');
      try {
        await fh.writeFile(content);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return {
        sha256: createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length,
      };
    }

    // Adjuntos grandes: streaming con hash "al vuelo", nunca Buffer completo en memoria.
    const hasher = new HashingPassthrough();
    await pipeline(content, hasher, createWriteStream(tmpPath));
    await this.fsyncPath(tmpPath);
    return { sha256: hasher.digest(), sizeBytes: hasher.bytesWritten };
  }

  private async fsyncPath(path: string): Promise<void> {
    const fh = await open(path, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async hashIfExists(absolutePath: string): Promise<string | null> {
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk as Buffer);
      }
      return hash.digest('hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async removeTmpFilesRecursively(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.removeTmpFilesRecursively(entryPath);
        } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
          await rm(entryPath, { force: true });
        }
      }),
    );
  }
}
