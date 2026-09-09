import { AnexoCell } from '../anexo/build-anexo-row';

/**
 * Adaptador CSV del Anexo 3 (Addendum 10, §8.2).
 *
 * Formato exigido por Hacienda:
 * - delimitador `;`
 * - terminador CRLF
 * - SIN fila de encabezado
 * - UTF-8 **sin BOM**
 *
 * Lo del BOM no es una preferencia: los tres bytes `EF BB BF` quedarían
 * pegados al inicio de la columna A de la primera fila, que debe medir
 * exactamente 10 caracteres (`DD/MM/AAAA`). Con BOM, la validación del portal
 * rechaza el archivo. Por eso no se ofrece la opción.
 */

export const CSV_DELIMITER = ';';
export const CSV_EOL = '\r\n';

/** Caracteres que obligan a entrecomillar una celda. */
const NEEDS_QUOTING = /[;"\r\n]/;

/**
 * Prefijos que Excel y LibreOffice interpretan como fórmula al abrir el CSV.
 * El tabulador y el retorno de carro entran porque también disparan la
 * interpretación en algunas versiones.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Neutraliza la inyección de fórmulas en celdas de texto libre.
 *
 * Solo aplica a `text`: los montos ya vienen normalizados a `0.00` y nunca son
 * negativos, así que el `-` no puede aparecer al inicio de una celda numérica.
 * Se antepone una comilla simple, que es la convención que ambas hojas de
 * cálculo entienden como "esto es texto literal".
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/** Entrecomilla solo si hace falta y duplica las comillas internas. */
export function escapeCsvValue(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Serializa una celda según su tipo. */
export function formatCsvCell(cell: AnexoCell): string {
  const value = cell.kind === 'text' ? neutralizeFormula(cell.value) : cell.value;
  return escapeCsvValue(value);
}

/** Una fila completa, con su terminador CRLF. */
export function formatCsvRow(cells: AnexoCell[]): string {
  return cells.map(formatCsvCell).join(CSV_DELIMITER) + CSV_EOL;
}
