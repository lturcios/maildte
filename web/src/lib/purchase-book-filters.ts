import type { ClassificationFilter } from '@/types/domain';

/**
 * Filtros del libro de compras, en un módulo propio y puro.
 *
 * Viven fuera de la página por dos razones. Se pueden testear sin renderizar
 * nada —igual que `buildPurchaseDocumentWhere` del backend, y por el mismo
 * motivo: es donde un error hace que el contador mire un conjunto de compras
 * distinto del que cree estar mirando—, y exportar constantes desde un archivo
 * de componentes rompe el fast refresh de Vite.
 */

/** Valor de un select de filtro cuando no acota nada. */
export const ALL = 'all';

/**
 * Valor del filtro de actividad para "compras sin actividad resuelta".
 *
 * Es el literal que entiende la API, y el filtro que más se usa después de
 * sembrar el catálogo: muestra exactamente lo que queda por resolver.
 */
export const SIN_ACTIVIDAD = 'none';

export const CLASSIFICATION_OPTIONS: { value: ClassificationFilter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'classified', label: 'Clasificadas' },
  { value: 'unclassified', label: 'Sin clasificar' },
];

export interface Filters {
  receptorId: string;
  emisorId: string;
  accountId: string;
  from: string;
  to: string;
  month: string;
  classification: ClassificationFilter;
  /** Id de una actividad, el literal `none`, o `ALL`. */
  activityId: string;
}

export const DEFAULT_FILTERS: Filters = {
  receptorId: ALL,
  emisorId: ALL,
  accountId: ALL,
  from: '',
  to: '',
  month: '',
  classification: 'all',
  activityId: ALL,
};

/**
 * Query de filtros SIN paginación: la usan el listado, el resumen y el export,
 * para que los tres miren exactamente el mismo conjunto de compras.
 */
export function buildFiltersQuery(filters: Filters, search: string): string {
  const params = new URLSearchParams();
  if (filters.receptorId !== ALL) params.set('receptorId', filters.receptorId);
  if (filters.emisorId !== ALL) params.set('emisorId', filters.emisorId);
  if (filters.accountId !== ALL) params.set('accountId', filters.accountId);
  if (filters.month) {
    params.set('month', filters.month);
  } else {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (search.trim()) params.set('q', search.trim());
  if (filters.classification !== 'all') params.set('classification', filters.classification);
  if (filters.activityId !== ALL) params.set('activityId', filters.activityId);
  return params.toString();
}

/**
 * Cuántos filtros están acotando el listado.
 *
 * El panel lo muestra, y por eso la actividad TIENE que contar: si no, un libro
 * filtrado por actividad se vería como el libro completo del contribuyente.
 */
export function countActiveFilters(filters: Filters, search: string): number {
  return [
    filters.receptorId !== ALL,
    filters.emisorId !== ALL,
    filters.accountId !== ALL,
    filters.from !== '',
    filters.to !== '',
    filters.month !== '',
    filters.classification !== 'all',
    filters.activityId !== ALL,
    search.trim() !== '',
  ].filter(Boolean).length;
}
