import type { AnexoDefaults, AnexoOverrides } from '@/types/domain';

/**
 * Precedencia de la clasificación Q–T en el cliente (Addendum 10, ADR-10.5).
 *
 *   override del documento → default del receptor → sin clasificar
 *
 * Duplica la regla del backend a propósito: la lista necesita mostrar el estado
 * efectivo de cada fila sin pedir un cálculo extra al servidor. El backend
 * sigue siendo la autoridad; esto es solo presentación.
 */

/** Primer período con las columnas Q–T vigentes: febrero de 2024. */
export const ANEXO_CLASSIFICATION_EPOCH = Date.UTC(2024, 1, 1);

export type ClassificationSource = 'override' | 'default' | 'missing';

export interface EffectiveColumn {
  code: number | null;
  source: ClassificationSource;
}

export interface EffectiveClassification {
  tipoOperacion: EffectiveColumn;
  clasificacion: EffectiveColumn;
  sector: EffectiveColumn;
  tipoCostoGasto: EffectiveColumn;
  /** Los cuatro códigos en orden Q, R, S, T, para el badge. */
  codes: (number | null)[];
  /** `true` si falta alguna columna y el export se bloquearía. */
  incomplete: boolean;
  /** Período anterior a la vigencia: el anexo pide "0" y no hay nada que clasificar. */
  preEpoch: boolean;
}

function resolveColumn(override: number | null, fallback: number | null): EffectiveColumn {
  if (override !== null) return { code: override, source: 'override' };
  if (fallback !== null) return { code: fallback, source: 'default' };
  return { code: null, source: 'missing' };
}

export function resolveEffectiveClassification(
  overrides: AnexoOverrides,
  defaults: AnexoDefaults | null,
  fecEmi: string,
): EffectiveClassification {
  const emitted = new Date(fecEmi).getTime();
  const preEpoch = Number.isFinite(emitted) && emitted < ANEXO_CLASSIFICATION_EPOCH;

  const tipoOperacion = resolveColumn(
    overrides.anexoTipoOperacion,
    defaults?.defaultTipoOperacion ?? null,
  );
  const clasificacion = resolveColumn(
    overrides.anexoClasificacion,
    defaults?.defaultClasificacion ?? null,
  );
  const sector = resolveColumn(overrides.anexoSector, defaults?.defaultSector ?? null);
  const tipoCostoGasto = resolveColumn(
    overrides.anexoTipoCostoGasto,
    defaults?.defaultTipoCostoGasto ?? null,
  );

  const columns = [tipoOperacion, clasificacion, sector, tipoCostoGasto];

  return {
    tipoOperacion,
    clasificacion,
    sector,
    tipoCostoGasto,
    codes: columns.map((column) => column.code),
    incomplete: !preEpoch && columns.some((column) => column.source === 'missing'),
    preEpoch,
  };
}

/**
 * Identificador del proveedor tal como se declara: 14 dígitos van a la columna
 * E (NIT) y 9 a la P (DUI homologado). Se muestra con su etiqueta para que el
 * contador vea cuál de las dos columnas se va a llenar.
 */
export function describeSupplierId(nit: string): { label: string; value: string } {
  const digits = nit.replace(/\D/g, '');
  if (digits.length === 9) return { label: 'DUI', value: digits };
  if (digits.length === 14) return { label: 'NIT', value: digits };
  return { label: 'ID', value: digits || nit };
}
