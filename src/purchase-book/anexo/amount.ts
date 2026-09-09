import { Prisma } from '@prisma/client';

/**
 * Formato de montos y fechas del Anexo 3 (Addendum 10, §8.4).
 *
 * Política de redondeo: HALF_UP a 2 decimales, nunca truncación y nunca
 * aritmética de `number`. Hacienda trunca lo que exceda 2 decimales al cargar
 * el archivo; al emitir exactamente 2, esa truncación es un no-op y el valor
 * coincide con el que el emisor ya redondeó en `resumen`.
 */

const SCALE = 2;

/**
 * Monto listo para el archivo: 2 decimales, punto decimal, sin separador de
 * miles. Los negativos se llevan a `0.00` porque el instructivo prohíbe valores
 * negativos; el caso se cuenta como anomalía en el resumen del export.
 */
export function toAnexoAmount(value: Prisma.Decimal): string {
  const rounded = value.toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP);
  // `isNegative()` también cubre el cero con signo: decimal.js conserva el signo
  // al redondear -0.004, y `toFixed` escupiría "-0.00", que el anexo rechaza.
  if (rounded.isNegative()) {
    return '0.00';
  }
  return rounded.toFixed(SCALE);
}

/**
 * `true` cuando el monto redondeado es negativo de verdad, o sea cuando se
 * recortó un valor visible. Un `-0` (por ejemplo -0.004) NO cuenta: se imprime
 * `0.00` igual que un cero positivo y no hay nada que el contador deba revisar.
 */
export function isNegativeAmount(value: Prisma.Decimal): boolean {
  const rounded = value.toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.isNegative() && !rounded.isZero();
}

/**
 * Redondea a 2 decimales conservando el tipo Decimal, para poder sumar columnas
 * ya redondeadas sin volver a `number`. Es lo que hace que la columna O cierre
 * con la verificación aritmética de Hacienda.
 */
export function roundToAnexoScale(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Fecha de emisión en `DD/MM/AAAA`, los 10 caracteres que espera la columna A.
 *
 * Usa los getters UTC a propósito: la columna es DATE y el driver la entrega
 * como medianoche UTC. Con getters locales, cualquier zona al oeste de
 * Greenwich mostraría el día anterior.
 */
export function formatFecEmi(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  return `${day}/${month}/${year}`;
}

/**
 * Número de documento de la columna D: el código de generación sin guiones.
 * Hacienda lo pide así explícitamente para los DTE.
 */
export function stripHyphens(value: string): string {
  return value.replace(/-/g, '');
}
