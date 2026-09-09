import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { MailProvider } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface MailProvidersState {
  providers: MailProvider[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;
  fetchProviders: (force?: boolean) => Promise<void>;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  providers: [] as MailProvider[],
  loading: false,
  loaded: false,
  error: null as string | null,
};

/**
 * Catálogo de servicios de correo habilitados (GET /mail-providers), global y
 * de solo lectura. Mismo patrón cacheado que useAccountsStore: el alta de
 * cuenta lo consulta cada vez que se abre el diálogo y no tiene sentido pegarle
 * a la API en cada apertura.
 *
 * El catálogo cambia solo cuando un SUPERADMIN lo edita, así que `force` existe
 * para que la pantalla de administración refresque después de guardar. Se
 * vacía igual al cambiar de sesión: es contenido de un endpoint autenticado y
 * la regla de src/stores/session.ts no hace excepciones.
 */
export const useMailProvidersStore = create<MailProvidersState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  fetchProviders: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    const { generation } = get();
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: MailProvider[] }>('/mail-providers');
      if (get().generation !== generation) {
        return;
      }
      set({ providers: response.data, loading: false, loaded: true });
    } catch (error) {
      if (get().generation !== generation) {
        return;
      }
      set({
        loading: false,
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudieron cargar los servicios de correo.',
      });
    }
  },

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => useMailProvidersStore.getState().reset());
