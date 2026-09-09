import { splitSupplierId } from './split-supplier-id';

describe('splitSupplierId', () => {
  it('manda un identificador de 14 dígitos a la columna E (NIT)', () => {
    expect(splitSupplierId('12171609731022')).toEqual({
      nit: '12171609731022',
      dui: '',
      anomalous: false,
    });
  });

  it('manda un identificador de 9 dígitos a la columna P (DUI homologado)', () => {
    // Caso real: el emisor de la muestra v3 del proyecto.
    expect(splitSupplierId('040522092')).toEqual({
      nit: '',
      dui: '040522092',
      anomalous: false,
    });
  });

  it('quita guiones y pleca antes de medir la longitud', () => {
    expect(splitSupplierId('0614-020390-102-8')).toEqual({
      nit: '06140203901028',
      dui: '',
      anomalous: false,
    });
    expect(splitSupplierId('04052209-2')).toEqual({
      nit: '',
      dui: '040522092',
      anomalous: false,
    });
  });

  it('nunca llena las dos columnas a la vez', () => {
    for (const value of ['12171609731022', '040522092', '123', '']) {
      const result = splitSupplierId(value);
      expect(result.nit === '' || result.dui === '').toBe(true);
    }
  });

  it('marca como anómala cualquier otra longitud y la informa en E', () => {
    expect(splitSupplierId('123')).toEqual({ nit: '123', dui: '', anomalous: true });
    expect(splitSupplierId('123456789012')).toEqual({
      nit: '123456789012',
      dui: '',
      anomalous: true,
    });
  });

  it('trata null, undefined y vacío como anomalía sin romper', () => {
    expect(splitSupplierId(null)).toEqual({ nit: '', dui: '', anomalous: true });
    expect(splitSupplierId(undefined)).toEqual({ nit: '', dui: '', anomalous: true });
    expect(splitSupplierId('')).toEqual({ nit: '', dui: '', anomalous: true });
  });

  it('descarta letras y espacios sin alterar la clasificación', () => {
    expect(splitSupplierId(' 0405 2209 2 ')).toEqual({
      nit: '',
      dui: '040522092',
      anomalous: false,
    });
  });
});
