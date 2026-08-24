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
