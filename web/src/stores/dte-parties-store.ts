import { create } from 'zustand';

import { apiGet, apiPatch, ApiError } from '@/lib/api-client';
import type { DteParty, PartyRole, UpdatePartyDefaultsInput } from '@/types/domain';

import { registerSessionStore } from './session-registry';

interface RoleState {
  parties: DteParty[];
  loading: boolean;
  loaded: boolean;
}

const EMPTY_ROLE_STATE: RoleState = { parties: [], loading: false, loaded: false };

interface DtePartiesState {
  byRole: Record<PartyRole, RoleState>;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;
  fetchParties: (role: PartyRole, force?: boolean) => Promise<void>;
  updateDefaults: (id: string, input: UpdatePartyDefaultsInput) => Promise<DteParty>;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  byRole: { EMISOR: EMPTY_ROLE_STATE, RECEPTOR: EMPTY_ROLE_STATE } as Record<PartyRole, RoleState>,
  error: null as string | null,
};

/**
 * Catálogo de emisores y receptores del tenant (Addendum 10, §9.4).
 *
 * Se cachea por rol: los selects de filtro del libro piden emisores y
 * receptores por separado y ambas listas cambian solo cuando entra un DTE de un
 * proveedor nuevo. Pedirlas en cada render de la página sería gratuito para el
 * usuario pero innecesario para el servidor.
 *
 * El caché es por sesión: son datos del tenant autenticado, así que
 * `resetTenantStores()` lo vacía en cada login y logout (src/stores/session.ts).
 */
export const useDtePartiesStore = create<DtePartiesState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  fetchParties: async (role, force = false) => {
    const current = get().byRole[role];
    if (current.loading || (current.loaded && !force)) {
      return;
    }

    const { generation } = get();
    set((state) => ({
      byRole: { ...state.byRole, [role]: { ...state.byRole[role], loading: true } },
      error: null,
    }));

    try {
      const response = await apiGet<{ data: DteParty[] }>(
        `/purchase-book/parties?role=${role}&limit=500`,
      );
      if (get().generation !== generation) {
        return;
      }
      set((state) => ({
        byRole: {
          ...state.byRole,
          [role]: { parties: response.data, loading: false, loaded: true },
        },
      }));
    } catch (error) {
      if (get().generation !== generation) {
        return;
      }
      set((state) => ({
        byRole: { ...state.byRole, [role]: { ...state.byRole[role], loading: false } },
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudo cargar el catálogo de emisores y receptores.',
      }));
    }
  },

  /**
   * Guarda los defaults Q–T de una parte y refleja el cambio en las dos listas
   * cacheadas: la misma parte puede aparecer como emisor y como receptor.
   */
  updateDefaults: async (id, input) => {
    const response = await apiPatch<{ data: DteParty }>(
      `/purchase-book/parties/${id}/defaults`,
      input,
    );
    const updated = response.data;

    set((state) => ({
      byRole: {
        EMISOR: replaceParty(state.byRole.EMISOR, updated),
        RECEPTOR: replaceParty(state.byRole.RECEPTOR, updated),
      },
    }));

    return updated;
  },

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => useDtePartiesStore.getState().reset());

function replaceParty(roleState: RoleState, updated: DteParty): RoleState {
  if (!roleState.loaded) {
    return roleState;
  }
  return {
    ...roleState,
    parties: roleState.parties.map((party) =>
      party.id === updated.id ? { ...party, ...updated } : party,
    ),
  };
}
