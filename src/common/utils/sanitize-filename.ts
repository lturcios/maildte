import { basename, extname } from 'path';

export function sanitizeFilename(name: string, maxLen = 180): string {
  const ext = extname(name).toLowerCase();
  let base = basename(name, extname(name))
    .replace(/[\/\\:*?"<>|]/g, '') // inválidos en filesystem
    .replace(/[\x00-\x1f\x7f]/g, '') // caracteres de control
    .replace(/\.\./g, '') // neutraliza traversal
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'archivo';
  return base.slice(0, maxLen - ext.length) + ext;
}
