import { rangeEnd, rangeStart } from './date-range';

describe('date-range', () => {
  describe('rangeStart', () => {
    it('ancla una fecha sin hora al primer instante UTC del día', () => {
      expect(rangeStart('2026-03-31').toISOString()).toBe('2026-03-31T00:00:00.000Z');
    });

    it('respeta un ISO 8601 completo sin tocarlo', () => {
      expect(rangeStart('2026-03-31T14:25:00.000Z').toISOString()).toBe('2026-03-31T14:25:00.000Z');
    });
  });

  describe('rangeEnd', () => {
    it('expande una fecha sin hora al último instante UTC del día (día "hasta" inclusivo)', () => {
      expect(rangeEnd('2026-03-31').toISOString()).toBe('2026-03-31T23:59:59.999Z');
    });

    it('respeta un ISO 8601 completo sin tocarlo', () => {
      expect(rangeEnd('2026-03-31T14:25:00.000Z').toISOString()).toBe('2026-03-31T14:25:00.000Z');
    });

    it('cubre el borde de fin de mes: un correo del 31 a las 23:00 UTC entra en el rango', () => {
      expect(new Date('2026-03-31T23:00:00.000Z') <= rangeEnd('2026-03-31')).toBe(true);
    });
  });
});
