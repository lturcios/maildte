const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliza el extremo inicial de un rango de fechas.
 *
 * Un valor "solo fecha" (`YYYY-MM-DD`, lo que envía un `<input type="date">`)
 * se ancla al primer instante UTC de ese día. Un ISO 8601 completo se respeta
 * tal cual: quien lo manda ya eligió el instante exacto.
 */
export function rangeStart(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
}

/**
 * Normaliza el extremo final de un rango de fechas.
 *
 * Un valor "solo fecha" se expande al último instante UTC de ese día, de modo
 * que "hasta el 31" incluya el día 31 completo y no solo su medianoche. Sin
 * esta expansión, un filtro `lte '2026-03-31'` descarta todo el día 31.
 */
export function rangeEnd(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}
