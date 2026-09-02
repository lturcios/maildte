import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { MailProvider } from '@/types/domain';

interface MailProvidersState {
  providers: MailProvider[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchProviders: (force?: boolean) => Promise<void>;
}

/**
 * Catálogo de servicios de correo habilitados (GET /mail-providers), global y
 * de solo lectura. Mismo patrón cacheado que useAccountsStore: el alta de
 * cuenta lo consulta cada vez que se abre el diálogo y no tiene sentido pegarle
 * a la API en cada apertura.
 *
 * El catálogo cambia solo cuando un SUPERADMIN lo edita, así que `force` existe
 * para que la pantalla de administración refresque después de guardar.
 */
export const useMailProvidersStore = create<MailProvidersState>((set, get) => ({
  providers: [],
  loading: false,
  loaded: false,
  error: null,

  fetchProviders: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: MailProvider[] }>('/mail-providers');
      set({ providers: response.data, loading: false, loaded: true });
    } catch (error) {
      set({
        loading: false,
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudieron cargar los servicios de correo.',
      });
    }
  },
}));
