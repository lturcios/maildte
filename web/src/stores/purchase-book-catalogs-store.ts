import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { CatalogOption, PurchaseBookCatalogs } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface CatalogsState {
  catalogs: PurchaseBookCatalogs | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;
  fetchCatalogs: () => Promise<void>;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  catalogs: null as PurchaseBookCatalogs | null,
  loading: false,
  loaded: false,
  error: null as string | null,
};

/**
 * Catálogos del Anexo 3 definidos por Hacienda (Addendum 10, ADR-10.4).
 *
 * Son listas cerradas que no dependen del tenant ni cambian en runtime, así que
 * se piden una sola vez por sesión y se comparten entre el editor de
 * clasificación del detalle y la pantalla de defaults por receptor.
 *
 * Aun así se vacía al cambiar de sesión, como todo store alimentado por la API
 * autenticada: la regla es una sola y no admite excepciones que haya que
 * recordar (ver src/stores/session.ts). El costo es un request por sesión.
 */
export const usePurchaseBookCatalogsStore = create<CatalogsState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  fetchCatalogs: async () => {
    if (get().loading || get().loaded) {
      return;
    }
    const { generation } = get();
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: PurchaseBookCatalogs }>('/purchase-book/catalogs');
      if (get().generation !== generation) {
        return;
      }
      set({ catalogs: response.data, loading: false, loaded: true });
    } catch (error) {
      if (get().generation !== generation) {
        return;
      }
      set({
        loading: false,
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudieron cargar los catálogos del anexo.',
      });
    }
  },

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => usePurchaseBookCatalogsStore.getState().reset());

/** Etiqueta legible de un código, o el propio código si no está en el catálogo. */
export function labelForCode(options: CatalogOption[] | undefined, code: number | null): string {
  if (code === null) {
    return '—';
  }
  const option = options?.find((item) => item.code === code);
  return option ? `${option.code} – ${option.label}` : String(code);
}
