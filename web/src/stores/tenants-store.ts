import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { AdminTenant } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface TenantsState {
  tenants: AdminTenant[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;
  fetchTenants: (force?: boolean) => Promise<void>;
  addTenant: (tenant: AdminTenant) => void;
  updateTenant: (tenant: AdminTenant) => void;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  tenants: [] as AdminTenant[],
  loading: false,
  loaded: false,
  error: null as string | null,
};

/**
 * Store global (sin persist) de tenants para la vista de administración
 * SUPERADMIN (OrganizacionesPage). Sigue el mismo patrón de
 * src/stores/accounts-store.ts, pero sin un hook `useTenants()` dedicado:
 * a diferencia de las cuentas (consumidas por Dashboard/Correos/Logs para
 * resolver accountId -> alias), esta store solo la consume una vista, así
 * que la indirección de un hook no se justifica.
 *
 * Es el listado de TODAS las organizaciones y solo lo puede ver un SUPERADMIN:
 * `resetTenantStores()` lo vacía al cambiar de sesión para que no sobreviva a
 * una sesión con menos privilegios (src/stores/session.ts).
 */
export const useTenantsStore = create<TenantsState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  fetchTenants: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    const { generation } = get();
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: AdminTenant[] }>('/admin/tenants');
      if (get().generation !== generation) {
        return;
      }
      set({ tenants: response.data, loading: false, loaded: true });
    } catch (error) {
      if (get().generation !== generation) {
        return;
      }
      set({
        loading: false,
        error: error instanceof ApiError ? error.message : 'No se pudieron cargar los tenants.',
      });
    }
  },

  addTenant: (tenant) => set((state) => ({ tenants: [tenant, ...state.tenants] })),

  updateTenant: (tenant) =>
    set((state) => ({
      tenants: state.tenants.map((item) => (item.id === tenant.id ? tenant : item)),
    })),

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => useTenantsStore.getState().reset());
