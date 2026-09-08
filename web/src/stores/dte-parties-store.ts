import { create } from 'zustand';

import { apiGet, apiPatch, ApiError } from '@/lib/api-client';
import type { DteParty, PartyRole, UpdatePartyDefaultsInput } from '@/types/domain';

interface RoleState {
  parties: DteParty[];
  loading: boolean;
  loaded: boolean;
}

const EMPTY_ROLE_STATE: RoleState = { parties: [], loading: false, loaded: false };

interface DtePartiesState {
  byRole: Record<PartyRole, RoleState>;
  error: string | null;
  fetchParties: (role: PartyRole, force?: boolean) => Promise<void>;
  updateDefaults: (id: string, input: UpdatePartyDefaultsInput) => Promise<DteParty>;
}

/**
 * Catálogo de emisores y receptores del tenant (Addendum 10, §9.4).
 *
 * Se cachea por rol: los selects de filtro del libro piden emisores y
 * receptores por separado y ambas listas cambian solo cuando entra un DTE de un
 * proveedor nuevo. Pedirlas en cada render de la página sería gratuito para el
 * usuario pero innecesario para el servidor.
 */
export const useDtePartiesStore = create<DtePartiesState>((set, get) => ({
  byRole: { EMISOR: EMPTY_ROLE_STATE, RECEPTOR: EMPTY_ROLE_STATE },
  error: null,

  fetchParties: async (role, force = false) => {
    const current = get().byRole[role];
    if (current.loading || (current.loaded && !force)) {
      return;
    }

    set((state) => ({
      byRole: { ...state.byRole, [role]: { ...state.byRole[role], loading: true } },
      error: null,
    }));

    try {
      const response = await apiGet<{ data: DteParty[] }>(
        `/purchase-book/parties?role=${role}&limit=500`,
      );
      set((state) => ({
        byRole: {
          ...state.byRole,
          [role]: { parties: response.data, loading: false, loaded: true },
        },
      }));
    } catch (error) {
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
}));

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
