import { Prisma } from '@prisma/client';

/**
 * Helpers de lectura de JSON no confiable (Addendum 10, ADR-10.7).
 *
 * Reglas que hacen a la seguridad de este módulo:
 *
 * 1. El acceso a propiedades es siempre por `Object.prototype.hasOwnProperty.call`.
 *    Nunca `in`, nunca spread, nunca merge del objeto crudo sobre otro: una clave
 *    `__proto__` en el archivo del emisor queda inerte porque solo se leen valores.
 * 2. Los errores se acumulan en un `DteFieldError[]` en vez de lanzar, para reportar
 *    todos los problemas de un archivo en una sola pasada.
 * 3. Los montos nunca pasan por aritmética de `number`: se convierten a
 *    `Prisma.Decimal` apenas se leen (regla de ADR-10.3).
 */

/** Un problema concreto encontrado al leer el JSON, con la ruta del campo. */
export interface DteFieldError {
  /** Ruta con notación de punto: `resumen.totalGravada`, `cuerpoDocumento[0].cantidad`. */
  path: string;
  /** Mensaje en español, apto para mostrarse en el ledger de parseo. */
  message: string;
}

/** Acumulador de errores que comparten todos los helpers de una misma pasada. */
export class DteErrorCollector {
  private readonly errors: DteFieldError[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  get hasErrors(): boolean {
    return this.errors.length > 0;
  }

  list(): DteFieldError[] {
    return [...this.errors];
  }
}

/**
 * `true` solo para objetos planos. Rechaza arrays, `null` y cualquier cosa con
 * un `Symbol.toStringTag` raro. No confía en `typeof === 'object'` a secas.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

/**
 * Lectura cruda de una propiedad propia. Devuelve `undefined` si la clave no
 * existe como propiedad propia, aunque exista en el prototipo.
 */
export function readOwn(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** `true` cuando el valor es `undefined` o `null` (el DTE usa ambos para "no aplica"). */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function join(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

// ---------------------------------------------------------------------------
// Objetos y arrays
// ---------------------------------------------------------------------------

/** Sub-objeto obligatorio. Registra error y devuelve `null` si falta o no es objeto. */
export function getRequiredObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): Record<string, unknown> | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) {
    errors.add(join(path, key), 'campo obligatorio ausente');
    return null;
  }
  if (!isPlainObject(value)) {
    errors.add(join(path, key), 'se esperaba un objeto');
    return null;
  }
  return value;
}

/** Sub-objeto opcional. Un valor presente pero de otro tipo sí es error. */
export function getOptionalObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): Record<string, unknown> | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) return null;
  if (!isPlainObject(value)) {
    errors.add(join(path, key), 'se esperaba un objeto');
    return null;
  }
  return value;
}

/** Array obligatorio y no vacío. */
export function getRequiredArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): unknown[] | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) {
    errors.add(join(path, key), 'campo obligatorio ausente');
    return null;
  }
  if (!Array.isArray(value)) {
    errors.add(join(path, key), 'se esperaba un arreglo');
    return null;
  }
  if (value.length === 0) {
    errors.add(join(path, key), 'el arreglo no puede estar vacío');
    return null;
  }
  return value;
}

/** Array opcional. Ausente o `null` devuelve `[]`, que es lo que el DTE quiere decir. */
export function getOptionalArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): unknown[] {
  const value = readOwn(obj, key);
  if (isAbsent(value)) return [];
  if (!Array.isArray(value)) {
    errors.add(join(path, key), 'se esperaba un arreglo');
    return [];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * String obligatorio, recortado. Acepta números y los convierte, porque algunos
 * emisores mandan `codEstable` o `nrc` como número.
 */
export function getRequiredString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): string | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) {
    errors.add(join(path, key), 'campo obligatorio ausente');
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    errors.add(join(path, key), 'se esperaba texto');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.add(join(path, key), 'campo obligatorio vacío');
    return null;
  }
  return trimmed;
}

/**
 * String opcional. Ausente, `null` o cadena vacía devuelven `null`; un tipo
 * inesperado se reporta como error para no enmascarar archivos deformes.
 */
export function getOptionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): string | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    errors.add(join(path, key), 'se esperaba texto');
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Enteros
// ---------------------------------------------------------------------------

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/** Entero obligatorio. Acepta string numérico entero (`"1"`). */
export function getRequiredInt(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): number | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) {
    errors.add(join(path, key), 'campo obligatorio ausente');
    return null;
  }
  const parsed = coerceInt(value);
  if (parsed === null) {
    errors.add(join(path, key), 'se esperaba un número entero');
    return null;
  }
  return parsed;
}

/** Entero opcional. */
export function getOptionalInt(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): number | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) return null;
  const parsed = coerceInt(value);
  if (parsed === null) {
    errors.add(join(path, key), 'se esperaba un número entero');
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Montos (Decimal)
// ---------------------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Convierte un valor JSON a `Prisma.Decimal` sin pasar por aritmética de punto
 * flotante: el `number` se serializa a string y de ahí a Decimal (ADR-10.3).
 *
 * Acepta `number` finito y string numérico (`"176.99"`), porque hay emisores que
 * mandan los montos entre comillas. Devuelve `null` para cualquier otra cosa.
 */
export function toDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Prisma.Decimal(String(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!NUMERIC.test(trimmed)) return null;
    return new Prisma.Decimal(trimmed);
  }
  return null;
}

/** Monto obligatorio. */
export function getRequiredDecimal(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): Prisma.Decimal | null {
  const value = readOwn(obj, key);
  if (isAbsent(value)) {
    errors.add(join(path, key), 'campo obligatorio ausente');
    return null;
  }
  const decimal = toDecimal(value);
  if (decimal === null) {
    errors.add(join(path, key), 'se esperaba un número');
    return null;
  }
  return decimal;
}

/**
 * Monto opcional con default. Los campos de retención y percepción faltan con
 * frecuencia y su ausencia significa cero, no error (§3.2 del Addendum 10).
 */
export function getDecimalOrZero(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: DteErrorCollector,
): Prisma.Decimal {
  const value = readOwn(obj, key);
  if (isAbsent(value)) return new Prisma.Decimal(0);
  const decimal = toDecimal(value);
  if (decimal === null) {
    errors.add(join(path, key), 'se esperaba un número');
    return new Prisma.Decimal(0);
  }
  return decimal;
}

/**
 * Primer monto no ausente entre varias claves alias. Es el mecanismo de
 * compatibilidad v3/v4: `ivaRete1` (v3) e `ivaRete` (v4) son el mismo dato.
 * Si ninguna clave está presente devuelve cero.
 */
export function getAliasedDecimalOrZero(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  errors: DteErrorCollector,
): Prisma.Decimal {
  for (const key of keys) {
    if (!isAbsent(readOwn(obj, key))) {
      return getDecimalOrZero(obj, key, path, errors);
    }
  }
  return new Prisma.Decimal(0);
}

/** Primer string no vacío entre varias claves alias (`observaciones` v3/v4). */
export function getAliasedOptionalString(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  errors: DteErrorCollector,
): string | null {
  for (const key of keys) {
    if (!isAbsent(readOwn(obj, key))) {
      const value = getOptionalString(obj, key, path, errors);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * Valor crudo para las secciones que se guardan como `jsonb` sin normalizar
 * (`documentoRelacionado`, `apendice`, ...). No valida forma a propósito:
 * lo que llegue se archiva tal cual.
 */
export function getRawSection(obj: Record<string, unknown>, key: string): unknown {
  const value = readOwn(obj, key);
  return isAbsent(value) ? null : value;
}
