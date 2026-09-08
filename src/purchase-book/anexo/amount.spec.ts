import { Prisma } from '@prisma/client';
import {
  formatFecEmi,
  isNegativeAmount,
  roundToAnexoScale,
  stripHyphens,
  toAnexoAmount,
} from './amount';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

describe('toAnexoAmount', () => {
  it('siempre emite exactamente 2 decimales', () => {
    expect(toAnexoAmount(d(0))).toBe('0.00');
    expect(toAnexoAmount(d(144))).toBe('144.00');
    expect(toAnexoAmount(d('1500'))).toBe('1500.00');
  });

  it('redondea HALF_UP, no trunca', () => {
    expect(toAnexoAmount(d('1.005'))).toBe('1.01');
    expect(toAnexoAmount(d('1.004'))).toBe('1.00');
    expect(toAnexoAmount(d('2.675'))).toBe('2.68');
  });

  it('recorta la precisión extendida de precioUni', () => {
    expect(toAnexoAmount(d('176.99115044'))).toBe('176.99');
  });

  it('lleva los negativos a 0.00, que es lo que exige el instructivo', () => {
    expect(toAnexoAmount(d('-0.5'))).toBe('0.00');
    expect(toAnexoAmount(d('-1500.25'))).toBe('0.00');
  });

  it('no usa separador de miles', () => {
    expect(toAnexoAmount(d('10500.5'))).toBe('10500.50');
    expect(toAnexoAmount(d('1234567.891'))).toBe('1234567.89');
  });

  it('no arrastra el error de punto flotante de 0.1 + 0.2', () => {
    expect(toAnexoAmount(d('0.1').plus(d('0.2')))).toBe('0.30');
  });
});

describe('isNegativeAmount', () => {
  it('detecta negativos reales', () => {
    expect(isNegativeAmount(d('-0.01'))).toBe(true);
    expect(isNegativeAmount(d('0'))).toBe(false);
    expect(isNegativeAmount(d('0.01'))).toBe(false);
  });

  it('no marca un negativo que redondea a cero', () => {
    // -0.004 redondea a 0.00: la celda queda correcta y no hay nada que revisar.
    expect(isNegativeAmount(d('-0.004'))).toBe(false);
  });
});

describe('roundToAnexoScale', () => {
  it('conserva el tipo Decimal para poder seguir sumando', () => {
    const result = roundToAnexoScale(d('176.99115044'));
    expect(result).toBeInstanceOf(Prisma.Decimal);
    expect(result.toString()).toBe('176.99');
  });

  it('permite que G + J + N cierre con los valores ya impresos', () => {
    const g = roundToAnexoScale(d('0'));
    const j = roundToAnexoScale(d('176.99'));
    const n = roundToAnexoScale(d('23.01'));
    expect(toAnexoAmount(g.plus(j).plus(n))).toBe('200.00');
  });
});

describe('formatFecEmi', () => {
  it('formatea DD/MM/AAAA con 10 caracteres', () => {
    const value = formatFecEmi(new Date('2026-03-19T00:00:00.000Z'));
    expect(value).toBe('19/03/2026');
    expect(value).toHaveLength(10);
  });

  it('rellena con cero el día y el mes', () => {
    expect(formatFecEmi(new Date('2026-01-05T00:00:00.000Z'))).toBe('05/01/2026');
  });

  it('usa getters UTC: una fecha DATE no se corre un día', () => {
    // El proyecto corre en América Central (UTC-6). Con getters locales, la
    // medianoche UTC del día 1 mostraría el último día del mes anterior.
    expect(formatFecEmi(new Date('2026-05-01T00:00:00.000Z'))).toBe('01/05/2026');
    expect(formatFecEmi(new Date('2026-01-01T00:00:00.000Z'))).toBe('01/01/2026');
  });

  it('maneja el último día del año', () => {
    expect(formatFecEmi(new Date('2026-12-31T00:00:00.000Z'))).toBe('31/12/2026');
  });
});

describe('stripHyphens', () => {
  it('quita los guiones del código de generación', () => {
    expect(stripHyphens('FC5B1AE1-07F1-42CA-A7DA-AB4F8A3381D2')).toBe(
      'FC5B1AE107F142CAA7DAAB4F8A3381D2',
    );
  });

  it('deja intacto lo que no tiene guiones', () => {
    expect(stripHyphens('ABC123')).toBe('ABC123');
  });

  it('no excede los 100 caracteres de la columna D', () => {
    const value = stripHyphens('0B4E2221-74CF-4550-A451-31BBFB5CC9FD');
    expect(value.length).toBeLessThanOrEqual(100);
    expect(value).toBe('0B4E222174CF4550A45131BBFB5CC9FD');
  });
});
