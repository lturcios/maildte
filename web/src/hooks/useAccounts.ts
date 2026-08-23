import { useEffect, useMemo } from 'react';

import { useAccountsStore } from '@/stores/accounts-store';
import type { SafeAccount } from '@/types/domain';

interface UseAccountsResult {
  accounts: SafeAccount[];
  accountsById: Map<string, SafeAccount>;
  /** Alias de la cuenta o, si todavía no cargó / fue eliminada, el propio id. */
  getAlias: (accountId: string) => string;
  loading: boolean;
  error: string | null;
}

/**
 * Resuelve `accountId` -> alias para las vistas que solo reciben el UUID
 * (Dashboard, Correos, Logs) y alimenta los selects de filtro "Cuenta".
 * Dispara el fetch una sola vez (cacheado en useAccountsStore) al montar el
 * primer consumidor; llamadas subsiguientes reusan el mismo estado global.
 */
export function useAccounts(): UseAccountsResult {
  const accounts = useAccountsStore((state) => state.accounts);
  const loading = useAccountsStore((state) => state.loading);
  const loaded = useAccountsStore((state) => state.loaded);
  const error = useAccountsStore((state) => state.error);
  const fetchAccounts = useAccountsStore((state) => state.fetchAccounts);

  useEffect(() => {
    if (!loaded) {
      void fetchAccounts();
    }
  }, [loaded, fetchAccounts]);

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const getAlias = useMemo(
    () => (accountId: string) => accountsById.get(accountId)?.alias ?? accountId,
    [accountsById],
  );

  return { accounts, accountsById, getAlias, loading, error };
}
