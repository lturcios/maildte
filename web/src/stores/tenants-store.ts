import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { AdminTenant } from '@/types/domain';

interface TenantsState {
  tenants: AdminTenant[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchTenants: (force?: boolean) => Promise<void>;
  addTenant: (tenant: AdminTenant) => void;
  updateTenant: (tenant: AdminTenant) => void;
}

/**
 * Store global (sin persist) de tenants para la vista de administración
 * SUPERADMIN (OrganizacionesPage). Sigue el mismo patrón de
 * src/stores/accounts-store.ts, pero sin un hook `useTenants()` dedicado:
 * a diferencia de las cuentas (consumidas por Dashboard/Correos/Logs para
 * resolver accountId -> alias), esta store solo la consume una vista, así
 * que la indirección de un hook no se justifica.
 */
export const useTenantsStore = create<TenantsState>((set, get) => ({
  tenants: [],
  loading: false,
  loaded: false,
  error: null,

  fetchTenants: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: AdminTenant[] }>('/admin/tenants');
      set({ tenants: response.data, loading: false, loaded: true });
    } catch (error) {
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
}));
