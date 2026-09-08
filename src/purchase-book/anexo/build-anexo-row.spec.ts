import { Prisma } from '@prisma/client';
import { ANEXO_COLUMN_COUNT, AnexoDocumentInput, buildAnexoRow } from './build-anexo-row';
import { ClassificationDefaults } from './resolve-classification';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Documento equivalente a la muestra v3 del proyecto
 * (`src/purchase-book/__fixtures__/ccf-v3.json`), ya parseado y persistido.
 */
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

/** Equivalente a la muestra v4. */
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

const DEFAULTS: ClassificationDefaults = {
  defaultTipoOperacion: 1,
  defaultClasificacion: 2,
  defaultSector: 4,
  defaultTipoCostoGasto: 2,
};

/** Solo los valores, que es lo que termina en el archivo. */
function values(doc: AnexoDocumentInput, defaults: ClassificationDefaults | null) {
  return buildAnexoRow(doc, defaults).cells.map((cell) => cell.value);
}

describe('buildAnexoRow', () => {
  it('emite exactamente 21 columnas', () => {
    expect(buildAnexoRow(DOC_V3, DEFAULTS).cells).toHaveLength(ANEXO_COLUMN_COUNT);
    expect(buildAnexoRow(DOC_V4, null).cells).toHaveLength(ANEXO_COLUMN_COUNT);
  });

  it('arma la fila completa de la muestra v3', () => {
    expect(values(DOC_V3, DEFAULTS)).toEqual([
      '19/03/2026', // A fecha de emisión
      '4', // B clase de documento: DTE
      '03', // C tipo de documento: crédito fiscal
      'FC5B1AE107F142CAA7DAAB4F8A3381D2', // D código de generación sin guiones
      '', // E NIT vacío: el proveedor va por DUI
      'Manuel Eduardo Umanzor Jiménez', // F nombre del proveedor
      '0.00', // G exentas y no sujetas
      '0.00', // H internaciones exentas
      '0.00', // I importaciones exentas
      '176.99', // J compras internas gravadas
      '0.00', // K internaciones gravadas
      '0.00', // L importaciones gravadas de bienes
      '0.00', // M importaciones gravadas de servicios
      '23.01', // N crédito fiscal
      '200.00', // O total de compras = G + J + N
      '040522092', // P DUI del proveedor (9 dígitos)
      '1', // Q tipo de operación
      '2', // R clasificación
      '4', // S sector
      '2', // T tipo de costo/gasto
      '3', // U número de anexo
    ]);
  });

  it('arma la fila completa de la muestra v4', () => {
    const row = values(DOC_V4, DEFAULTS);
    expect(row[0]).toBe('28/05/2026');
    expect(row[3]).toBe('0B4E222174CF4550A45131BBFB5CC9FD');
    expect(row[9]).toBe('144.00');
    expect(row[13]).toBe('18.72');
    expect(row[14]).toBe('162.72');
    expect(row[15]).toBe('027561310');
  });

  it('la columna O coincide con montoTotalOperacion en las dos muestras', () => {
    expect(values(DOC_V3, DEFAULTS)[14]).toBe('200.00');
    expect(values(DOC_V4, DEFAULTS)[14]).toBe('162.72');
  });

  it('mantiene las constantes del anexo en B y U', () => {
    const row = values(DOC_V4, DEFAULTS);
    expect(row[1]).toBe('4');
    expect(row[20]).toBe('3');
  });

  it('deja en 0.00 las columnas que un crédito fiscal nunca alimenta', () => {
    const row = values(DOC_V3, DEFAULTS);
    for (const index of [7, 8, 10, 11, 12]) {
      expect(row[index]).toBe('0.00');
    }
  });

  describe('columna G: exentas más no sujetas', () => {
    it('suma los dos totales', () => {
      const row = values({ ...DOC_V4, totalExenta: d('10.50'), totalNoSuj: d('5.25') }, DEFAULTS);
      expect(row[6]).toBe('15.75');
    });

    it('redondea la suma, no cada sumando por separado', () => {
      const row = values({ ...DOC_V4, totalExenta: d('0.005'), totalNoSuj: d('0.005') }, DEFAULTS);
      expect(row[6]).toBe('0.01');
    });
  });

  describe('tipos de celda', () => {
    it('marca como texto las columnas de identificación, para conservar ceros a la izquierda', () => {
      const cells = buildAnexoRow(DOC_V3, DEFAULTS).cells;
      // A, C, D, E, F, P, Q, R, S, T
      for (const index of [0, 2, 3, 4, 5, 15, 16, 17, 18, 19]) {
        expect(cells[index].kind).toBe('text');
      }
      expect(cells[2].value).toBe('03');
    });

    it('marca como monto las columnas G a O', () => {
      const cells = buildAnexoRow(DOC_V3, DEFAULTS).cells;
      for (let index = 6; index <= 14; index += 1) {
        expect(cells[index].kind).toBe('amount');
      }
    });

    it('marca como entero las constantes B y U', () => {
      const cells = buildAnexoRow(DOC_V3, DEFAULTS).cells;
      expect(cells[1].kind).toBe('int');
      expect(cells[20].kind).toBe('int');
    });
  });

  describe('regla E/P del proveedor', () => {
    it('llena E y deja P vacío para un NIT de 14 dígitos', () => {
      const row = values({ ...DOC_V4, emisorNit: '06140203901028' }, DEFAULTS);
      expect(row[4]).toBe('06140203901028');
      expect(row[15]).toBe('');
    });

    it('llena P y deja E vacío para un identificador de 9 dígitos', () => {
      const row = values(DOC_V3, DEFAULTS);
      expect(row[4]).toBe('');
      expect(row[15]).toBe('040522092');
    });

    it('marca la anomalía cuando la longitud no es 9 ni 14', () => {
      const result = buildAnexoRow({ ...DOC_V4, emisorNit: '123' }, DEFAULTS);
      expect(result.flags.supplierIdAnomaly).toBe(true);
      expect(result.cells[4].value).toBe('123');
      expect(result.cells[15].value).toBe('');
    });
  });

  describe('clasificación Q a T', () => {
    it('deja las celdas vacías y avisa cuando no hay override ni default', () => {
      const result = buildAnexoRow(DOC_V4, null);
      expect(result.cells.slice(16, 20).map((cell) => cell.value)).toEqual(['', '', '', '']);
      expect(result.flags.incompleteClassification).toBe(true);
    });

    it('el override del documento gana sobre el default del receptor', () => {
      const row = values({ ...DOC_V4, anexoSector: 1 }, DEFAULTS);
      expect(row[18]).toBe('1');
      expect(row[17]).toBe('2');
    });

    it('exporta 0 en Q a T para períodos anteriores a febrero 2024', () => {
      const row = values({ ...DOC_V3, fecEmi: new Date('2023-06-15T00:00:00.000Z') }, null);
      expect(row.slice(16, 20)).toEqual(['0', '0', '0', '0']);
    });

    it('no marca incompleto un período anterior a la vigencia', () => {
      const result = buildAnexoRow(
        { ...DOC_V3, fecEmi: new Date('2023-06-15T00:00:00.000Z') },
        null,
      );
      expect(result.flags.incompleteClassification).toBe(false);
    });
  });

  describe('banderas de anomalía', () => {
    it('no levanta ninguna bandera con un documento sano', () => {
      expect(buildAnexoRow(DOC_V3, DEFAULTS).flags).toEqual({
        supplierIdAnomaly: false,
        negativeAmount: false,
        totalMismatch: false,
        incompleteClassification: false,
      });
    });

    it('detecta un monto negativo y lo exporta como 0.00', () => {
      const result = buildAnexoRow(
        { ...DOC_V4, totalGravada: d('-10'), montoTotalOperacion: d('8.72') },
        DEFAULTS,
      );
      expect(result.flags.negativeAmount).toBe(true);
      expect(result.cells[9].value).toBe('0.00');
    });

    it('detecta cuando G + J + N no coincide con montoTotalOperacion', () => {
      const result = buildAnexoRow({ ...DOC_V4, montoTotalOperacion: d('999.99') }, DEFAULTS);
      expect(result.flags.totalMismatch).toBe(true);
    });

    it('tolera una diferencia de un centavo sin marcarla', () => {
      const result = buildAnexoRow({ ...DOC_V4, montoTotalOperacion: d('162.73') }, DEFAULTS);
      expect(result.flags.totalMismatch).toBe(false);
    });
  });

  it('respeta el límite de 100 caracteres de la columna D', () => {
    expect(values(DOC_V3, DEFAULTS)[3].length).toBeLessThanOrEqual(100);
  });

  it('emite montos con exactamente 2 decimales en las columnas G a O', () => {
    const row = values(DOC_V3, DEFAULTS);
    for (let index = 6; index <= 14; index += 1) {
      expect(row[index]).toMatch(/^\d+\.\d{2}$/);
    }
  });
});
