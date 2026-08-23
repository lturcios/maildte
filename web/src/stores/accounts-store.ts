import { create } from 'zustand';

import { apiGet, ApiError } from '@/lib/api-client';
import type { SafeAccount } from '@/types/domain';

interface AccountsState {
  accounts: SafeAccount[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchAccounts: (force?: boolean) => Promise<void>;
  addAccount: (account: SafeAccount) => void;
  updateAccount: (account: SafeAccount) => void;
  removeAccount: (id: string) => void;
}

/**
 * Store global (sin persist) de cuentas IMAP del tenant. Varias vistas
 * (Dashboard, Correos, Logs) solo reciben `accountId` de sus endpoints y
 * necesitan resolverlo a alias — este store centraliza el fetch de
 * GET /accounts para no repetirlo por vista. Se consume vía el hook
 * `useAccounts()` en src/hooks/useAccounts.ts.
 */
export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  loaded: false,
  error: null,

  fetchAccounts: async (force = false) => {
    if (get().loading) {
      return;
    }
    if (get().loaded && !force) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const response = await apiGet<{ data: SafeAccount[] }>('/accounts');
      set({ accounts: response.data, loading: false, loaded: true });
    } catch (error) {
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
}));
