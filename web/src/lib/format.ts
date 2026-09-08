/**
 * Helpers de formato compartidos por las vistas de contenido (Dashboard,
 * Cuentas, Correos, Logs). Sin dependencias externas: `Intl` ya cubre lo
 * que necesitamos (tamaños de archivo, fechas relativas y absolutas).
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

export function formatRelativeTime(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  let duration = (date.getTime() - Date.now()) / 1000;

  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return RELATIVE_TIME_FORMATTER.format(Math.round(duration), 'years');
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-SV', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function formatDateTime(dateInput: string | Date | null): string {
  if (!dateInput) {
    return '—';
  }
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return DATE_TIME_FORMATTER.format(date);
}

/** yyyy-mm-dd de hoy en UTC — tope superior para los `<input type="date">` de syncFromDate. */
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const MONEY_FORMATTER = new Intl.NumberFormat('es-SV', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formatea un monto que la API entrega como STRING.
 *
 * Los montos del libro de compras son Decimal(18,8) en el backend y viajan como
 * texto justamente para no perder precision. Aca se convierte a number SOLO
 * para mostrar: el valor formateado nunca vuelve al servidor.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return MONEY_FORMATTER.format(0);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? MONEY_FORMATTER.format(parsed) : String(value);
}

const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat('es-SV', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Formatea una fecha calendario (columna DATE) como DD/MM/AAAA.
 *
 * La zona se fuerza a UTC porque el backend entrega `fecEmi` a medianoche UTC:
 * con la zona local (UTC-6) se mostraria el dia anterior.
 */
export function formatDateOnly(dateInput: string | null | undefined): string {
  if (!dateInput) {
    return '—';
  }
  const date = new Date(dateInput);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY_FORMATTER.format(date);
}

/** `YYYY-MM` del mes actual, para el atajo de periodo fiscal. */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
