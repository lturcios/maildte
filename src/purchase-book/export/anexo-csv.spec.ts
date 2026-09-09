import { Prisma } from '@prisma/client';
import {
  CSV_DELIMITER,
  CSV_EOL,
  escapeCsvValue,
  formatCsvCell,
  formatCsvRow,
  neutralizeFormula,
} from './anexo-csv';
import { AnexoCell, AnexoDocumentInput, buildAnexoRow } from '../anexo/build-anexo-row';
import { ClassificationDefaults } from '../anexo/resolve-classification';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

const text = (value: string): AnexoCell => ({ kind: 'text', value });
const amount = (value: string): AnexoCell => ({ kind: 'amount', value });

const DEFAULTS: ClassificationDefaults = {
  defaultTipoOperacion: 1,
  defaultClasificacion: 2,
  defaultSector: 4,
  defaultTipoCostoGasto: 2,
};

/** Muestra v4 del proyecto, ya parseada. */
const DOC_V4: AnexoDocumentInput = {
  fecEmi: new Date('2026-05-28T00:00:00.000Z'),
  tipoDte: '03',
  codigoGeneracion: '0B4E2221-74CF-4550-A451-31BBFB5CC9FD',
  emisorNit: '027561310',
  emisorNombre: 'LUIS ANTONIO TURCIOS ALVAREZ',
  totalExenta: d(0),
  totalNoSuj: d(0),
  totalGravada: d('144'),
  ivaCreditoFiscal: d('18.72'),
  montoTotalOperacion: d('162.72'),
  anexoTipoOperacion: null,
  anexoClasificacion: null,
  anexoSector: null,
  anexoTipoCostoGasto: null,
};

describe('escapeCsvValue', () => {
  it('no entrecomilla lo que no lo necesita', () => {
    expect(escapeCsvValue('LTSOFT')).toBe('LTSOFT');
    expect(escapeCsvValue('144.00')).toBe('144.00');
    expect(escapeCsvValue('')).toBe('');
  });

  it('entrecomilla cuando hay punto y coma', () => {
    expect(escapeCsvValue('EMPRESA; S.A.')).toBe('"EMPRESA; S.A."');
  });

  it('entrecomilla y duplica las comillas internas', () => {
    expect(escapeCsvValue('EMPRESA "LA MEJOR"')).toBe('"EMPRESA ""LA MEJOR"""');
  });

  it('entrecomilla ante saltos de línea', () => {
    expect(escapeCsvValue('LINEA1\nLINEA2')).toBe('"LINEA1\nLINEA2"');
    expect(escapeCsvValue('LINEA1\r\nLINEA2')).toBe('"LINEA1\r\nLINEA2"');
  });

  it('no entrecomilla una coma: el delimitador es el punto y coma', () => {
    expect(escapeCsvValue('SOCIEDAD, ANONIMA')).toBe('SOCIEDAD, ANONIMA');
  });
});

describe('neutralizeFormula', () => {
  it('neutraliza los prefijos que Excel interpreta como fórmula', () => {
    expect(neutralizeFormula('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(neutralizeFormula('+1234')).toBe("'+1234");
    expect(neutralizeFormula('-1234')).toBe("'-1234");
    expect(neutralizeFormula('@import')).toBe("'@import");
    expect(neutralizeFormula('\tvalor')).toBe("'\tvalor");
  });

  it('deja intacto un nombre normal de proveedor', () => {
    expect(neutralizeFormula('LUIS ANTONIO TURCIOS ALVAREZ')).toBe('LUIS ANTONIO TURCIOS ALVAREZ');
  });

  it('solo mira el primer carácter', () => {
    expect(neutralizeFormula('EMPRESA = MEJOR')).toBe('EMPRESA = MEJOR');
  });
});

describe('formatCsvCell', () => {
  it('neutraliza fórmulas solo en celdas de texto', () => {
    expect(formatCsvCell(text('=CMD()'))).toBe("'=CMD()");
  });

  it('no toca los montos: nunca empiezan con un signo', () => {
    expect(formatCsvCell(amount('0.00'))).toBe('0.00');
    expect(formatCsvCell(amount('144.00'))).toBe('144.00');
  });

  it('combina neutralización y escape cuando hacen falta las dos', () => {
    expect(formatCsvCell(text('=A1;B2'))).toBe('"\'=A1;B2"');
  });
});

describe('formatCsvRow', () => {
  it('usa punto y coma como delimitador y CRLF como terminador', () => {
    const row = formatCsvRow([text('a'), text('b'), text('c')]);
    expect(row).toBe(`a${CSV_DELIMITER}b${CSV_DELIMITER}c${CSV_EOL}`);
    expect(CSV_EOL).toBe('\r\n');
  });

  it('serializa la muestra v4 con las 21 columnas exactas', () => {
    const { cells } = buildAnexoRow(DOC_V4, DEFAULTS);
    const row = formatCsvRow(cells);

    expect(row).toBe(
      '28/05/2026;4;03;0B4E222174CF4550A45131BBFB5CC9FD;;LUIS ANTONIO TURCIOS ALVAREZ;' +
        '0.00;0.00;0.00;144.00;0.00;0.00;0.00;18.72;144.00;027561310;1;2;4;2;3\r\n',
    );
  });

  it('emite exactamente 20 delimitadores para 21 columnas', () => {
    const { cells } = buildAnexoRow(DOC_V4, DEFAULTS);
    const row = formatCsvRow(cells).replace(CSV_EOL, '');
    expect(row.split(CSV_DELIMITER)).toHaveLength(21);
  });

  it('deja vacías las columnas Q a T cuando no hay clasificación', () => {
    const { cells } = buildAnexoRow(DOC_V4, null);
    const fields = formatCsvRow(cells).replace(CSV_EOL, '').split(CSV_DELIMITER);
    expect(fields.slice(16, 20)).toEqual(['', '', '', '']);
  });

  it('no antepone BOM: el primer byte es el de la fecha', () => {
    const { cells } = buildAnexoRow(DOC_V4, DEFAULTS);
    const buffer = Buffer.from(formatCsvRow(cells), 'utf8');

    expect(buffer[0]).not.toBe(0xef);
    expect(buffer.subarray(0, 10).toString('utf8')).toBe('28/05/2026');
  });

  it('un archivo de varias filas es la concatenación directa', () => {
    const { cells } = buildAnexoRow(DOC_V4, DEFAULTS);
    const file = formatCsvRow(cells) + formatCsvRow(cells);

    expect(file.split(CSV_EOL).filter((line) => line.length > 0)).toHaveLength(2);
    expect(file.endsWith(CSV_EOL)).toBe(true);
  });

  it('protege un nombre de proveedor con punto y coma sin romper el conteo de columnas', () => {
    const { cells } = buildAnexoRow(
      { ...DOC_V4, emisorNombre: 'DISTRIBUIDORA; S.A. DE C.V.' },
      DEFAULTS,
    );
    const row = formatCsvRow(cells).replace(CSV_EOL, '');

    expect(row).toContain('"DISTRIBUIDORA; S.A. DE C.V."');
    // El punto y coma entrecomillado no debe contarse como separador.
    expect(row.split('";').length).toBe(2);
  });
});
