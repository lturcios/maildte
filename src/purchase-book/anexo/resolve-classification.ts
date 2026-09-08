/**
 * Precedencia de la clasificación Q–T del Anexo 3 (Addendum 10, ADR-10.5).
 *
 *   override del documento  →  default del receptor  →  sin clasificar
 *
 * Las columnas Q, R, S y T no existen en el DTE: son criterio contable del
 * contribuyente. Por eso cada receptor tiene defaults configurables y cada
 * documento puede corregirlos.
 *
 * Períodos anteriores a febrero de 2024 llevan `0` en las cuatro columnas, tal
 * como indica el instructivo. Ese `0` no es una clasificación: es literalmente
 * lo que Hacienda pide para los períodos viejos.
 */

/** Primer período en que las columnas Q–T son obligatorias: febrero de 2024. */
export const ANEXO_CLASSIFICATION_EPOCH = new Date('2024-02-01T00:00:00.000Z');

/** Valor exportado para períodos anteriores a la vigencia de Q–T. */
export const PRE_EPOCH_CODE = '0';

/** De dónde salió el valor efectivo de cada columna. */
export type ClassificationSource = 'override' | 'default' | 'pre-2024-02' | 'missing';

/** Los cuatro códigos del documento (null = sin override). */
export interface ClassificationOverrides {
  anexoTipoOperacion: number | null;
  anexoClasificacion: number | null;
  anexoSector: number | null;
  anexoTipoCostoGasto: number | null;
}

/** Los cuatro defaults del receptor (null = sin default). */
export interface ClassificationDefaults {
  defaultTipoOperacion: number | null;
  defaultClasificacion: number | null;
  defaultSector: number | null;
  defaultTipoCostoGasto: number | null;
}

/** Una columna resuelta: el código a exportar y su origen. */
export interface ResolvedColumn {
  /** Código efectivo, o `null` si quedó sin clasificar. */
  code: number | null;
  /** Texto listo para el archivo: el código, `'0'` pre-2024-02, o cadena vacía. */
  value: string;
  source: ClassificationSource;
}

export interface ResolvedClassification {
  tipoOperacion: ResolvedColumn;
  clasificacion: ResolvedColumn;
  sector: ResolvedColumn;
  tipoCostoGasto: ResolvedColumn;
  /** `true` si al menos una columna quedó sin clasificar (bloquea el export). */
  incomplete: boolean;
}

function resolveColumn(
  override: number | null,
  fallback: number | null,
  preEpoch: boolean,
): ResolvedColumn {
  // El período manda sobre todo lo demás: antes de 2024-02 la celda es "0",
  // aunque el contador haya clasificado el documento.
  if (preEpoch) {
    return { code: null, value: PRE_EPOCH_CODE, source: 'pre-2024-02' };
  }
  if (override !== null) {
    return { code: override, value: String(override), source: 'override' };
  }
  if (fallback !== null) {
    return { code: fallback, value: String(fallback), source: 'default' };
  }
  return { code: null, value: '', source: 'missing' };
}

/**
 * Resuelve las cuatro columnas de un documento.
 *
 * @param fecEmi fecha de emisión del documento, que define si aplica la vigencia.
 */
export function resolveClassification(
  overrides: ClassificationOverrides,
  defaults: ClassificationDefaults | null,
  fecEmi: Date,
): ResolvedClassification {
  const preEpoch = fecEmi.getTime() < ANEXO_CLASSIFICATION_EPOCH.getTime();

  const tipoOperacion = resolveColumn(
    overrides.anexoTipoOperacion,
    defaults?.defaultTipoOperacion ?? null,
    preEpoch,
  );
  const clasificacion = resolveColumn(
    overrides.anexoClasificacion,
    defaults?.defaultClasificacion ?? null,
    preEpoch,
  );
  const sector = resolveColumn(overrides.anexoSector, defaults?.defaultSector ?? null, preEpoch);
  const tipoCostoGasto = resolveColumn(
    overrides.anexoTipoCostoGasto,
    defaults?.defaultTipoCostoGasto ?? null,
    preEpoch,
  );

  const incomplete = [tipoOperacion, clasificacion, sector, tipoCostoGasto].some(
    (column) => column.source === 'missing',
  );

  return { tipoOperacion, clasificacion, sector, tipoCostoGasto, incomplete };
}
