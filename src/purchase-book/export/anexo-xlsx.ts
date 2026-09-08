import { Writable } from 'stream';
import writeXlsxFile, { CellObject, SheetData } from 'write-excel-file/node';
import { AnexoCell } from '../anexo/build-anexo-row';

/**
 * Adaptador XLSX del Anexo 3 (Addendum 10, §8.3).
 *
 * Librería: `write-excel-file` (ver ADR-10.6). `exceljs` y `xlsx` quedan
 * prohibidas por CVE sin parche; no reintroducirlas.
 *
 * Tipado de celdas — no es cosmético:
 *
 * - Las columnas de identificación (fecha, tipo de documento, código de
 *   generación, NIT, DUI, nombre y las Q–T) van como **texto**. Si fueran
 *   número, Excel comería los ceros a la izquierda de `03` y de un DUI como
 *   `040522092`, y el archivo quedaría rechazado.
 * - La fecha también va como texto: una fecha real de Excel se convierte en
 *   número de serie al re-guardar como CSV.
 * - Los montos van como número con formato `0.00`, para que la hoja los sume
 *   y los muestre siempre con dos decimales.
 */

/** Formato numérico de dos decimales, sin separador de miles. */
const AMOUNT_FORMAT = '0.00';

/** Encabezado legible, solo para revisión humana. Hacienda no lo acepta. */
export const ANEXO_HEADER = [
  'Fecha de emisión',
  'Clase de documento',
  'Tipo de documento',
  'Número de documento',
  'NIT o NRC del proveedor',
  'Nombre del proveedor',
  'Compras internas exentas y/o no sujetas',
  'Internaciones exentas y/o no sujetas',
  'Importaciones exentas y/o no sujetas',
  'Compras internas gravadas',
  'Internaciones gravadas de bienes',
  'Importaciones gravadas de bienes',
  'Importaciones gravadas de servicios',
  'Crédito fiscal',
  'Total de compras',
  'DUI del proveedor',
  'Tipo de operación',
  'Clasificación',
  'Sector',
  'Tipo de costo/gasto',
  'Número de anexo',
] as const;

/** Convierte una celda del builder a la representación de la librería. */
export function toXlsxCell(cell: AnexoCell): CellObject {
  if (cell.kind === 'amount') {
    return { value: Number(cell.value), type: Number, format: AMOUNT_FORMAT };
  }
  if (cell.kind === 'int') {
    return { value: Number(cell.value), type: Number };
  }
  // Texto: una cadena vacía se escribe como celda vacía, no como "".
  return cell.value === '' ? {} : { value: cell.value, type: String };
}

export function toXlsxRow(cells: AnexoCell[]): CellObject[] {
  return cells.map(toXlsxCell);
}

function headerRow(): CellObject[] {
  return ANEXO_HEADER.map((label) => ({ value: label, type: String, fontWeight: 'bold' }));
}

/**
 * Construye el libro completo en memoria y lo vuelca al stream de respuesta.
 *
 * El tope de filas del export (`PURCHASE_BOOK_EXPORT_MAX_ROWS`) es lo que
 * acota este uso de memoria; la librería no ofrece escritura incremental.
 */
export async function writeAnexoXlsx(
  rows: AnexoCell[][],
  target: Writable,
  options: { header?: boolean } = {},
): Promise<void> {
  const data: SheetData = [...(options.header ? [headerRow()] : []), ...rows.map(toXlsxRow)];

  await writeXlsxFile(data, { sheet: 'Detalle de compras' }).toStream(target);
}

/** Variante para tests: devuelve el archivo como buffer. */
export async function buildAnexoXlsxBuffer(
  rows: AnexoCell[][],
  options: { header?: boolean } = {},
): Promise<Buffer> {
  const data: SheetData = [...(options.header ? [headerRow()] : []), ...rows.map(toXlsxRow)];

  return writeXlsxFile(data, { sheet: 'Detalle de compras' }).toBuffer();
}
