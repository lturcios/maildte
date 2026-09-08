import {
  ANEXO_CLASSIFICATION_EPOCH,
  ClassificationDefaults,
  ClassificationOverrides,
  resolveClassification,
} from './resolve-classification';

const NO_OVERRIDES: ClassificationOverrides = {
  anexoTipoOperacion: null,
  anexoClasificacion: null,
  anexoSector: null,
  anexoTipoCostoGasto: null,
};

const FULL_DEFAULTS: ClassificationDefaults = {
  defaultTipoOperacion: 1,
  defaultClasificacion: 2,
  defaultSector: 4,
  defaultTipoCostoGasto: 2,
};

const AFTER_EPOCH = new Date('2026-05-28T00:00:00.000Z');
const BEFORE_EPOCH = new Date('2023-11-15T00:00:00.000Z');

describe('resolveClassification', () => {
  it('usa el default del receptor cuando el documento no tiene override', () => {
    const result = resolveClassification(NO_OVERRIDES, FULL_DEFAULTS, AFTER_EPOCH);

    expect(result.tipoOperacion).toEqual({ code: 1, value: '1', source: 'default' });
    expect(result.clasificacion).toEqual({ code: 2, value: '2', source: 'default' });
    expect(result.sector).toEqual({ code: 4, value: '4', source: 'default' });
    expect(result.tipoCostoGasto).toEqual({ code: 2, value: '2', source: 'default' });
    expect(result.incomplete).toBe(false);
  });

  it('el override del documento gana sobre el default del receptor', () => {
    const result = resolveClassification(
      { ...NO_OVERRIDES, anexoClasificacion: 1 },
      FULL_DEFAULTS,
      AFTER_EPOCH,
    );

    expect(result.clasificacion).toEqual({ code: 1, value: '1', source: 'override' });
    // Las demás siguen viniendo del default.
    expect(result.sector.source).toBe('default');
  });

  it('marca incompleto cuando falta una columna y no hay default', () => {
    const result = resolveClassification(
      NO_OVERRIDES,
      { ...FULL_DEFAULTS, defaultSector: null },
      AFTER_EPOCH,
    );

    expect(result.sector).toEqual({ code: null, value: '', source: 'missing' });
    expect(result.incomplete).toBe(true);
  });

  it('marca incompleto cuando el receptor no tiene defaults', () => {
    const result = resolveClassification(NO_OVERRIDES, null, AFTER_EPOCH);

    expect(result.incomplete).toBe(true);
    expect(result.tipoOperacion.value).toBe('');
    expect(result.tipoCostoGasto.source).toBe('missing');
  });

  it('un override completo alcanza aunque el receptor no tenga defaults', () => {
    const result = resolveClassification(
      {
        anexoTipoOperacion: 1,
        anexoClasificacion: 2,
        anexoSector: 3,
        anexoTipoCostoGasto: 7,
      },
      null,
      AFTER_EPOCH,
    );

    expect(result.incomplete).toBe(false);
    expect(result.tipoCostoGasto).toEqual({ code: 7, value: '7', source: 'override' });
  });

  describe('vigencia de febrero 2024', () => {
    it('exporta 0 en las cuatro columnas para períodos anteriores', () => {
      const result = resolveClassification(NO_OVERRIDES, null, BEFORE_EPOCH);

      for (const column of [
        result.tipoOperacion,
        result.clasificacion,
        result.sector,
        result.tipoCostoGasto,
      ]) {
        expect(column.value).toBe('0');
        expect(column.source).toBe('pre-2024-02');
      }
      // El "0" no es una clasificación pendiente: no debe bloquear el export.
      expect(result.incomplete).toBe(false);
    });

    it('el período manda incluso si el documento está clasificado', () => {
      const result = resolveClassification(
        {
          anexoTipoOperacion: 1,
          anexoClasificacion: 2,
          anexoSector: 3,
          anexoTipoCostoGasto: 4,
        },
        FULL_DEFAULTS,
        BEFORE_EPOCH,
      );

      expect(result.tipoOperacion.value).toBe('0');
      expect(result.tipoOperacion.source).toBe('pre-2024-02');
    });

    it('el primer día de febrero 2024 ya exige clasificación', () => {
      const result = resolveClassification(NO_OVERRIDES, FULL_DEFAULTS, ANEXO_CLASSIFICATION_EPOCH);
      expect(result.tipoOperacion.source).toBe('default');
    });

    it('el día anterior a la vigencia todavía exporta 0', () => {
      const result = resolveClassification(
        NO_OVERRIDES,
        FULL_DEFAULTS,
        new Date('2024-01-31T00:00:00.000Z'),
      );
      expect(result.tipoOperacion.source).toBe('pre-2024-02');
    });
  });

  it('acepta los códigos transversales 8 y 9', () => {
    const result = resolveClassification(
      {
        anexoTipoOperacion: 8,
        anexoClasificacion: 9,
        anexoSector: 8,
        anexoTipoCostoGasto: 9,
      },
      null,
      AFTER_EPOCH,
    );

    expect(result.tipoOperacion.value).toBe('8');
    expect(result.clasificacion.value).toBe('9');
    expect(result.incomplete).toBe(false);
  });
});
