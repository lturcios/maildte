import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { MailProvider, MailProviderUsageMap } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface AdminMailProvidersState {
  providers: MailProvider[];
  /** Uso por perfil, indexado por id. Ver el comentario de fetchUsage. */
  usage: MailProviderUsageMap;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;
  fetchProviders: (force?: boolean) => Promise<void>;
  fetchUsage: () => Promise<void>;
  upsertProvider: (provider: MailProvider) => void;
  removeProvider: (id: string) => void;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  providers: [] as MailProvider[],
  usage: {} as MailProviderUsageMap,
  loading: false,
  loaded: false,
  error: null as string | null,
};

/**
 * Catálogo COMPLETO para la pantalla de SUPERADMIN: a diferencia de
 * useMailProvidersStore (que consume el alta de cuentas y solo trae los
 * perfiles habilitados), este pega a /admin/mail-providers e incluye los
 * deshabilitados.
 *
 * `usage` es un agregado que recorre TODAS las organizaciones, así que este
 * store no puede sobrevivir a un cambio de sesión: `resetTenantStores()` lo
 * vacía en cada login y logout (src/stores/session.ts).
 */
export const useAdminMailProvidersStore = create<AdminMailProvidersState>((set, get) => ({
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
      const response = await apiGet<{ data: MailProvider[] }>('/admin/mail-providers');
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

  /**
   * Uso de TODOS los perfiles en una sola llamada. El backend no puede exponer
   * el conteo dentro del listado porque `email_accounts` tiene RLS por tenant y
   * hay que recorrer las organizaciones para contarlas (ver usageAll() en
   * mail-providers.service.ts). Falla en silencio: el uso es informativo, y la
   * tabla tiene que renderizar igual.
   */
  fetchUsage: async () => {
    const { generation } = get();
    try {
      const response = await apiGet<{ data: MailProviderUsageMap }>('/admin/mail-providers/usage');
      if (get().generation !== generation) {
        return;
      }
      set({ usage: response.data });
    } catch {
      if (get().generation !== generation) {
        return;
      }
      set({ usage: {} });
    }
  },

  upsertProvider: (provider) =>
    set((state) => {
      const exists = state.providers.some((item) => item.id === provider.id);
      return {
        providers: exists
          ? state.providers.map((item) => (item.id === provider.id ? provider : item))
          : [...state.providers, provider],
      };
    }),

  removeProvider: (id) =>
    set((state) => ({ providers: state.providers.filter((item) => item.id !== id) })),

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => useAdminMailProvidersStore.getState().reset());
