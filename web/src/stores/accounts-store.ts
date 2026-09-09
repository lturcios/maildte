import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { SafeAccount } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface AccountsState {
  accounts: SafeAccount[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /**
   * Sesión a la que pertenecen los datos cacheados. `reset()` la incrementa y
   * todo fetch en vuelo descarta su respuesta si cambió mientras esperaba: sin
   * esto, un `/accounts` disparado antes del logout repoblaría el store con las
   * cuentas del tenant anterior justo después de haberlo vaciado.
   */
  generation: number;
  fetchAccounts: (force?: boolean) => Promise<void>;
  addAccount: (account: SafeAccount) => void;
  updateAccount: (account: SafeAccount) => void;
  removeAccount: (id: string) => void;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  accounts: [] as SafeAccount[],
  loading: false,
  loaded: false,
  error: null as string | null,
};

/**
 * Store global (sin persist) de cuentas IMAP del tenant. Varias vistas
 * (Dashboard, Correos, Logs) solo reciben `accountId` de sus endpoints y
 * necesitan resolverlo a alias — este store centraliza el fetch de
 * GET /accounts para no repetirlo por vista. Se consume vía el hook
 * `useAccounts()` en src/hooks/useAccounts.ts.
 *
 * Los datos son del tenant autenticado: `resetTenantStores()` lo vacía en cada
 * cambio de sesión (ver src/stores/session.ts).
 */
export const useAccountsStore = create<AccountsState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  fetchAccounts: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    const { generation } = get();
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: SafeAccount[] }>('/accounts');
      if (get().generation !== generation) {
        return;
      }
      set({ accounts: response.data, loading: false, loaded: true });
    } catch (error) {
      if (get().generation !== generation) {
        return;
      }
      set({
        loading: false,
        error: error instanceof ApiError ? error.message : 'No se pudieron cargar las cuentas.',
      });
    }
  },

  addAccount: (account) => set((state) => ({ accounts: [account, ...state.accounts] })),

  updateAccount: (account) =>
    set((state) => ({
      accounts: state.accounts.map((item) => (item.id === account.id ? account : item)),
    })),

  removeAccount: (id) =>
    set((state) => ({ accounts: state.accounts.filter((item) => item.id !== id) })),

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => useAccountsStore.getState().reset());
