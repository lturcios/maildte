---
name: atomic-storage
description: Reglas y patrones para toda escritura o lectura de archivos en STORAGE_ROOT de MailDTE. Usar siempre que se manipulen adjuntos en disco, se construyan rutas de storage, se calcule la carpeta mensual, se sanitizen nombres de archivo, se calculen hashes o se resuelvan colisiones. Cubre estructura cuenta/YYYY-MM/json|pdf, escritura atómica tmp+fsync+rename, zona horaria America/El_Salvador y protección path traversal.
---

# Skill: atomic-storage

## Cuándo aplica
Cualquier código en `storage/` y cualquier lugar que construya rutas bajo `STORAGE_ROOT` o escriba/lea/borre archivos de adjuntos.

## Estructura inmutable

```
{STORAGE_ROOT}/{folderName}/{YYYY-MM}/{json|pdf}/{archivo}
```

- `folderName`: se calcula **una vez** al crear la cuenta (lowercase, `@` y `.` → `_`, solo `[a-z0-9_-]`) y se lee de BD. Nunca recalcular desde el email en runtime.
- `YYYY-MM`: por fecha de **recepción** del correo, en TZ `America/El_Salvador`.

## resolveMonthFolder — único punto de conversión de TZ

```typescript
// storage.service.ts — NO duplicar esta lógica en ningún otro archivo
resolveMonthFolder(receivedAt: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: this.config.tzFolder,      // America/El_Salvador
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(receivedAt);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  return `${y}-${m}`;                    // "2026-08"
}
```

**Caso de prueba obligatorio**: `2026-09-01T03:00:00Z` → `"2026-08"` (en El Salvador son las 21:00 del 31 de agosto). BD siempre guarda UTC; solo la carpeta usa hora local. El resultado se persiste en `ProcessedEmail.monthFolder` — nunca se recalcula para archivos ya guardados.

## Sanitización de nombres

```typescript
export function sanitizeFilename(name: string, maxLen = 180): string {
  const ext = extname(name).toLowerCase();
  let base = basename(name, extname(name))
    .replace(/[\/\\:*?"<>|]/g, '')       // inválidos en filesystem
    .replace(/[\x00-\x1f\x7f]/g, '')     // caracteres de control
    .replace(/\.\./g, '')                // neutraliza traversal
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'archivo';
  return base.slice(0, maxLen - ext.length) + ext;
}
```

## Escritura atómica (obligatoria, sin excepciones)

```typescript
const tmp = `${finalPath}.tmp`;
const fh = await fs.open(tmp, 'w');
try {
  await fh.writeFile(content);           // o pipeline() para streams
  await fh.sync();                        // fsync antes de rename
} finally {
  await fh.close();
}
await fs.rename(tmp, finalPath);          // rename es atómico en el mismo FS
```

- Adjuntos > 5 MB: usar `Readable` + `pipeline` + hash por streaming (`createHash('sha256')` como transform), nunca `Buffer` completo.
- `cleanOrphanTmp(folderName)`: al inicio de cada sync, borrar `**/*.tmp` de la carpeta de la cuenta (restos de caídas).

## Colisiones de nombre (regla RF-04.4)

```
mismo nombre + mismo sha256   → NO escribir; retornar ruta existente, reused: true
mismo nombre + distinto sha256 → guardar como {base}_{sha256.slice(0,8)}{ext}
nombre libre                   → guardar normal
```

Nunca sobrescribir un archivo existente. El caso `reused` sigue creando el registro `Attachment` en BD (dos correos pueden traer el mismo PDF).

## Protección path traversal (en escritura Y lectura)

```typescript
const resolved = path.resolve(this.storageRoot, relativePath);
if (!resolved.startsWith(this.storageRoot + path.sep)) {
  throw new BadRequestException('Ruta fuera del área de almacenamiento');
}
```

Aplicar SIEMPRE: al guardar adjuntos, al servir descargas, al borrar en rollback. La API solo expone `relativePath`; las rutas absolutas del servidor jamás salen en respuestas.

## Rollback en disco

`deleteFiles(relativePaths[])`: borra en best-effort (ignora `ENOENT`, loggea otros errores) los archivos escritos de UN correo cuando su transacción de BD falla. Nunca borra archivos con `reused: true` (pertenecen a otro correo ya registrado).

## Prohibido
- `fs.writeFile` directo al destino final.
- Concatenar rutas con template strings (`` `${root}/${name}` ``): siempre `path.join` + validación.
- Recalcular monthFolder de correos ya persistidos.
- Cualquier conversión de zona horaria fuera de `resolveMonthFolder`.
