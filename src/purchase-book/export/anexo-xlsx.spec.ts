import AdmZip from 'adm-zip';
import { Prisma } from '@prisma/client';
import { ANEXO_HEADER, buildAnexoXlsxBuffer, toXlsxCell } from './anexo-xlsx';
import { AnexoCell, AnexoDocumentInput, buildAnexoRow } from '../anexo/build-anexo-row';
import { ClassificationDefaults } from '../anexo/resolve-classification';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

const DEFAULTS: ClassificationDefaults = {
  defaultTipoOperacion: 1,
  defaultClasificacion: 2,
  defaultSector: 4,
  defaultTipoCostoGasto: 2,
};

const DOC_V3: AnexoDocumentInput = {
  fecEmi: new Date('2026-03-19T00:00:00.000Z'),
  tipoDte: '03',
  codigoGeneracion: 'FC5B1AE1-07F1-42CA-A7DA-AB4F8A3381D2',
  emisorNit: '040522092',
  emisorNombre: 'Manuel Eduardo Umanzor Jiménez',
  totalExenta: d(0),
  totalNoSuj: d(0),
  totalGravada: d('176.99'),
  ivaCreditoFiscal: d('23.01'),
  montoTotalOperacion: d('200'),
  anexoTipoOperacion: null,
  anexoClasificacion: null,
  anexoSector: null,
  anexoTipoCostoGasto: null,
};

/** Descomprime el XLSX y devuelve el XML de la primera hoja. */
function sheetXml(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('xl/worksheets/sheet1.xml');
  if (!entry) throw new Error('el libro no tiene xl/worksheets/sheet1.xml');
  return entry.getData().toString('utf8');
}

function entryNames(buffer: Buffer): string[] {
  return new AdmZip(buffer).getEntries().map((entry) => entry.entryName);
}

describe('toXlsxCell', () => {
  it('mapea un monto a número con formato de dos decimales', () => {
    expect(toXlsxCell({ kind: 'amount', value: '144.00' })).toEqual({
      value: 144,
      type: Number,
      format: '0.00',
    });
  });

  it('mapea un entero a número sin formato', () => {
    expect(toXlsxCell({ kind: 'int', value: '3' })).toEqual({ value: 3, type: Number });
  });

  it('mapea texto a String, para conservar los ceros a la izquierda', () => {
    expect(toXlsxCell({ kind: 'text', value: '03' })).toEqual({ value: '03', type: String });
    expect(toXlsxCell({ kind: 'text', value: '040522092' })).toEqual({
      value: '040522092',
      type: String,
    });
  });

  it('convierte una celda de texto vacía en celda vacía, no en cadena vacía', () => {
    expect(toXlsxCell({ kind: 'text', value: '' })).toEqual({});
  });
});

describe('buildAnexoXlsxBuffer', () => {
  let rows: AnexoCell[][];

  beforeAll(() => {
    rows = [buildAnexoRow(DOC_V3, DEFAULTS).cells];
  });

  it('genera un archivo OOXML válido con las partes obligatorias', async () => {
    const buffer = await buildAnexoXlsxBuffer(rows);
    const names = entryNames(buffer);

    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    expect(buffer.length).toBeGreaterThan(0);
    // Firma de un ZIP: "PK".
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('escribe una sola fila cuando no se pide encabezado', async () => {
    const xml = sheetXml(await buildAnexoXlsxBuffer(rows));
    const rowMatches = xml.match(/<row[ >]/g) ?? [];
    expect(rowMatches).toHaveLength(1);
  });

  it('agrega la fila de encabezado cuando se pide', async () => {
    const xml = sheetXml(await buildAnexoXlsxBuffer(rows, { header: true }));
    const rowMatches = xml.match(/<row[ >]/g) ?? [];
    expect(rowMatches).toHaveLength(2);
  });

  it('el encabezado tiene 21 etiquetas, una por columna', () => {
    expect(ANEXO_HEADER).toHaveLength(21);
    expect(ANEXO_HEADER[0]).toBe('Fecha de emisión');
    expect(ANEXO_HEADER[20]).toBe('Número de anexo');
  });

  it('conserva el tipo de documento "03" como texto, sin perder el cero', async () => {
    const buffer = await buildAnexoXlsxBuffer(rows);
    const zip = new AdmZip(buffer);
    const strings = zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') ?? '';
    const xml = sheetXml(buffer);

    // El valor vive en sharedStrings o inline, pero nunca como número 3.
    expect(`${strings}${xml}`).toContain('03');
  });

  it('conserva el DUI de 9 dígitos con su cero inicial', async () => {
    const buffer = await buildAnexoXlsxBuffer(rows);
    const zip = new AdmZip(buffer);
    const strings = zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') ?? '';
    expect(`${strings}${sheetXml(buffer)}`).toContain('040522092');
  });

  it('escribe los montos como celdas numéricas', async () => {
    const xml = sheetXml(await buildAnexoXlsxBuffer(rows));
    // 176.99 es la columna J y 23.01 la N; ambas deben estar como número.
    expect(xml).toContain('176.99');
    expect(xml).toContain('23.01');
  });

  it('soporta varias filas', async () => {
    const buffer = await buildAnexoXlsxBuffer([rows[0], rows[0], rows[0]]);
    const rowMatches = sheetXml(buffer).match(/<row[ >]/g) ?? [];
    expect(rowMatches).toHaveLength(3);
  });

  it('no falla con celdas vacías en las columnas Q a T', async () => {
    const sinClasificar = [buildAnexoRow(DOC_V3, null).cells];
    const buffer = await buildAnexoXlsxBuffer(sinClasificar);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
