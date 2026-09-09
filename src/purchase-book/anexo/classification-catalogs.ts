/**
 * Catálogos del Anexo 3 "Detalle de Compras" (Addendum 10, ADR-10.4).
 *
 * Son listas cerradas definidas por el Ministerio de Hacienda. Viven como const
 * maps en TypeScript y no como tablas: no cambian con el tenant, no se editan
 * desde la app y necesitan etiqueta en español para el panel. Se exponen por
 * `GET /purchase-book/catalogs` para que el frontend tenga una sola fuente.
 *
 * Los códigos 8 y 9 son transversales a las cuatro columnas:
 * - 8: la operación se informa en más de un anexo (no se suma en Renta).
 * - 9: contribuyente con operaciones no deducibles (instituciones públicas,
 *   municipalidades).
 */

/** Una opción de catálogo: el código que va al archivo y su etiqueta. */
export interface CatalogOption {
  code: number;
  label: string;
}

/** Columna Q — Tipo de operación. */
export const TIPO_OPERACION: readonly CatalogOption[] = [
  { code: 1, label: 'Gravada' },
  { code: 2, label: 'No gravada' },
  { code: 3, label: 'Excluido o no constituye renta' },
  { code: 4, label: 'Mixta' },
  { code: 8, label: 'Operación informada en más de un anexo' },
  { code: 9, label: 'No deducible' },
] as const;

/** Columna R — Clasificación. */
export const CLASIFICACION: readonly CatalogOption[] = [
  { code: 1, label: 'Costo' },
  { code: 2, label: 'Gasto' },
  { code: 8, label: 'Operación informada en más de un anexo' },
  { code: 9, label: 'No deducible' },
] as const;

/** Columna S — Sector. */
export const SECTOR: readonly CatalogOption[] = [
  { code: 1, label: 'Industria' },
  { code: 2, label: 'Comercio' },
  { code: 3, label: 'Agropecuaria' },
  { code: 4, label: 'Servicios, profesiones, artes y oficios' },
  { code: 8, label: 'Operación informada en más de un anexo' },
  { code: 9, label: 'No deducible' },
] as const;

/** Columna T — Tipo de costo o gasto. */
export const TIPO_COSTO_GASTO: readonly CatalogOption[] = [
  { code: 1, label: 'Gastos de venta sin donación' },
  { code: 2, label: 'Gastos de administración sin donación' },
  { code: 3, label: 'Gastos financieros sin donación' },
  { code: 4, label: 'Costo de artículos producidos o comprados: importaciones e internaciones' },
  { code: 5, label: 'Costo de artículos producidos o comprados: interno' },
  { code: 6, label: 'Costos indirectos de fabricación' },
  { code: 7, label: 'Mano de obra' },
  { code: 8, label: 'Operación informada en más de un anexo' },
  { code: 9, label: 'No deducible' },
] as const;

/** Columna C — Tipo de documento admitido por el anexo de compras. */
export const TIPO_DOCUMENTO: readonly { code: string; label: string }[] = [
  { code: '03', label: 'Comprobante de Crédito Fiscal' },
  { code: '05', label: 'Nota de Crédito' },
  { code: '06', label: 'Nota de Débito' },
  { code: '11', label: 'Factura de Exportación' },
  { code: '12', label: 'Declaración de Mercancías' },
  { code: '13', label: 'Mandamiento de Ingreso' },
] as const;

/** Columna B — Clase de documento. El DTE siempre es 4. */
export const CLASE_DOCUMENTO: readonly CatalogOption[] = [
  { code: 1, label: 'Impreso por imprenta o tiquetes' },
  { code: 2, label: 'Formulario único' },
  { code: 3, label: 'Otros' },
  { code: 4, label: 'Documento Tributario Electrónico (DTE)' },
] as const;

/** `resumen.condicionOperacion` del DTE. No es del anexo, sirve al detalle del panel. */
export const CONDICION_OPERACION: readonly CatalogOption[] = [
  { code: 1, label: 'Contado' },
  { code: 2, label: 'A crédito' },
  { code: 3, label: 'Otro' },
] as const;

/** `resumen.pagos[].codigo` del DTE (catálogo CAT-017, subconjunto usual). */
export const FORMA_PAGO: readonly { code: string; label: string }[] = [
  { code: '01', label: 'Billetes y monedas' },
  { code: '02', label: 'Tarjeta débito' },
  { code: '03', label: 'Tarjeta crédito' },
  { code: '04', label: 'Cheque' },
  { code: '05', label: 'Transferencia o depósito bancario' },
  { code: '08', label: 'Dinero electrónico' },
  { code: '09', label: 'Monedero electrónico' },
  { code: '99', label: 'Otros' },
] as const;

function codesOf(options: readonly CatalogOption[]): number[] {
  return options.map((option) => option.code);
}

/**
 * Códigos válidos por columna, para `@IsIn` en los DTO y para las validaciones
 * del builder. Se derivan del catálogo: no hay una segunda lista que mantener.
 */
export const TIPO_OPERACION_CODES = codesOf(TIPO_OPERACION);
export const CLASIFICACION_CODES = codesOf(CLASIFICACION);
export const SECTOR_CODES = codesOf(SECTOR);
export const TIPO_COSTO_GASTO_CODES = codesOf(TIPO_COSTO_GASTO);

/** Catálogo completo tal como lo devuelve el endpoint. */
export const ANEXO_CATALOGS = {
  tipoOperacion: TIPO_OPERACION,
  clasificacion: CLASIFICACION,
  sector: SECTOR,
  tipoCostoGasto: TIPO_COSTO_GASTO,
  tipoDocumento: TIPO_DOCUMENTO,
  claseDocumento: CLASE_DOCUMENTO,
  condicionOperacion: CONDICION_OPERACION,
  formaPago: FORMA_PAGO,
} as const;

export type AnexoCatalogs = typeof ANEXO_CATALOGS;

/** `true` si el código pertenece al catálogo de esa columna. */
export function isValidCode(codes: readonly number[], value: number): boolean {
  return codes.includes(value);
}
