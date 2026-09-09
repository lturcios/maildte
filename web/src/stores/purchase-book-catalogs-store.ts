import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { CatalogOption, PurchaseBookCatalogs } from '@/types/domain';

interface CatalogsState {
  catalogs: PurchaseBookCatalogs | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchCatalogs: () => Promise<void>;
}

/**
 * Catálogos del Anexo 3 definidos por Hacienda (Addendum 10, ADR-10.4).
 *
 * Son listas cerradas que no dependen del tenant ni cambian en runtime, así que
 * se piden una sola vez por sesión y se comparten entre el editor de
 * clasificación del detalle y la pantalla de defaults por receptor.
 */
export const usePurchaseBookCatalogsStore = create<CatalogsState>((set, get) => ({
  catalogs: null,
  loading: false,
  loaded: false,
  error: null,

  fetchCatalogs: async () => {
    if (get().loading || get().loaded) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: PurchaseBookCatalogs }>('/purchase-book/catalogs');
      set({ catalogs: response.data, loading: false, loaded: true });
    } catch (error) {
      set({
        loading: false,
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudieron cargar los catálogos del anexo.',
      });
    }
  },
}));

/** Etiqueta legible de un código, o el propio código si no está en el catálogo. */
export function labelForCode(options: CatalogOption[] | undefined, code: number | null): string {
  if (code === null) {
    return '—';
  }
  const option = options?.find((item) => item.code === code);
  return option ? `${option.code} – ${option.label}` : String(code);
}
