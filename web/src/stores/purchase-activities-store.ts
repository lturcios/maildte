import { create } from 'zustand';

import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError } from '@/lib/api-client';
import type {
  ActivitySeedApplyResult,
  ActivitySeedProposal,
  ApplyActivitySeedInput,
  CreatePurchaseActivityInput,
  PurchaseActivity,
  SupplierActivityDefault,
  UpdatePurchaseActivityInput,
} from '@/types/domain';

import { registerSessionStore } from './session-registry';

/**
 * Catálogo de actividad y mapeo de proveedores (Addendum 11, fase 3).
 *
 * Todo el estado cuelga de un `receptorId`: el catálogo es POR CONTRIBUYENTE y
 * el mapeo de proveedores es una relación ternaria (tenant, receptor,
 * proveedor). Un store con una sola lista plana mezclaría el criterio contable
 * de dos empresas distintas, que es exactamente lo que el modelo del addendum
 * existe para impedir.
 *
 * Por eso no se cachea por receptor sino que se reemplaza al cambiar de
 * receptor: mantener varios catálogos en memoria a la vez invita a que un
 * render tome el del receptor anterior mientras llega el nuevo.
 */
interface PurchaseActivitiesState {
  /** Receptor al que corresponde TODO lo demás del store. */
  receptorId: string | null;
  activities: PurchaseActivity[];
  mappings: SupplierActivityDefault[];
  loading: boolean;
  error: string | null;
  /** Ver el comentario de `generation` en src/stores/accounts-store.ts. */
  generation: number;

  /** Carga catálogo y mapeo de un receptor. Descarta lo del receptor anterior. */
  load: (receptorId: string, includeInactive?: boolean) => Promise<void>;
  createActivity: (input: CreatePurchaseActivityInput) => Promise<PurchaseActivity>;
  updateActivity: (id: string, input: UpdatePurchaseActivityInput) => Promise<PurchaseActivity>;
  deactivateActivity: (id: string) => Promise<PurchaseActivity>;
  removeActivity: (id: string) => Promise<void>;
  setSupplierDefault: (emisorId: string, activityId: string) => Promise<void>;
  clearSupplierDefault: (emisorId: string) => Promise<void>;
  proposeSeed: (receptorId: string) => Promise<ActivitySeedProposal>;
  applySeed: (input: ApplyActivitySeedInput) => Promise<ActivitySeedApplyResult>;
  /** Ver src/stores/session.ts: no llamar suelto, se invoca al cambiar de sesión. */
  reset: () => void;
}

const INITIAL_STATE = {
  receptorId: null as string | null,
  activities: [] as PurchaseActivity[],
  mappings: [] as SupplierActivityDefault[],
  loading: false,
  error: null as string | null,
};

export const usePurchaseActivitiesStore = create<PurchaseActivitiesState>((set, get) => ({
  ...INITIAL_STATE,
  generation: 0,

  load: async (receptorId, includeInactive = true) => {
    const { generation } = get();
    // El receptor se fija ANTES de la respuesta: si el usuario cambia de
    // receptor mientras la petición viaja, el guard de abajo descarta la que
    // llegue tarde en vez de pintarla bajo el receptor equivocado.
    set({ receptorId, loading: true, error: null, activities: [], mappings: [] });

    try {
      const query = `receptorId=${receptorId}${includeInactive ? '&includeInactive=true' : ''}`;
      const [activities, mappings] = await Promise.all([
        apiGet<{ data: PurchaseActivity[] }>(`/purchase-book/activities?${query}`),
        apiGet<{ data: SupplierActivityDefault[] }>(
          `/purchase-book/supplier-activity-defaults?receptorId=${receptorId}`,
        ),
      ]);

      if (get().generation !== generation || get().receptorId !== receptorId) {
        return;
      }
      set({ activities: activities.data, mappings: mappings.data, loading: false });
    } catch (error) {
      if (get().generation !== generation || get().receptorId !== receptorId) {
        return;
      }
      set({
        loading: false,
        error:
          error instanceof ApiError
            ? error.message
            : 'No se pudo cargar el catálogo de actividad del contribuyente.',
      });
    }
  },

  createActivity: async (input) => {
    const response = await apiPost<{ data: PurchaseActivity }>('/purchase-book/activities', input);
    set((state) => ({ activities: sortActivities([...state.activities, response.data]) }));
    return response.data;
  },

  updateActivity: async (id, input) => {
    const response = await apiPatch<{ data: PurchaseActivity }>(
      `/purchase-book/activities/${id}`,
      input,
    );
    set((state) => ({
      activities: sortActivities(replaceActivity(state.activities, response.data)),
    }));
    return response.data;
  },

  deactivateActivity: async (id) => {
    const response = await apiPost<{ data: PurchaseActivity }>(
      `/purchase-book/activities/${id}/deactivate`,
    );
    set((state) => ({
      activities: sortActivities(replaceActivity(state.activities, response.data)),
    }));
    return response.data;
  },

  removeActivity: async (id) => {
    await apiDelete(`/purchase-book/activities/${id}`);
    set((state) => ({ activities: state.activities.filter((activity) => activity.id !== id) }));
  },

  setSupplierDefault: async (emisorId, activityId) => {
    const receptorId = requireReceptor(get().receptorId);
    await apiPut<{ data: SupplierActivityDefault }>('/purchase-book/supplier-activity-defaults', {
      receptorId,
      emisorId,
      activityId,
    });
    // Se recarga el mapeo en vez de parchearlo en memoria: la fila trae el
    // `documentCount` que ordena la lista, y el servidor es el único que lo
    // sabe. Inventarlo acá dejaría la pantalla ordenada por un dato fabricado.
    await get().load(receptorId);
  },

  clearSupplierDefault: async (emisorId) => {
    const receptorId = requireReceptor(get().receptorId);
    await apiDelete(
      `/purchase-book/supplier-activity-defaults?receptorId=${receptorId}&emisorId=${emisorId}`,
    );
    set((state) => ({
      mappings: state.mappings.filter((mapping) => mapping.emisorId !== emisorId),
    }));
  },

  proposeSeed: async (receptorId) => {
    const response = await apiGet<{ data: ActivitySeedProposal }>(
      `/purchase-book/activities/seed?receptorId=${receptorId}`,
    );
    return response.data;
  },

  applySeed: async (input) => {
    const response = await apiPost<{ data: ActivitySeedApplyResult }>(
      '/purchase-book/activities/seed',
      input,
    );
    await get().load(input.receptorId);
    return response.data;
  },

  reset: () => set((state) => ({ ...INITIAL_STATE, generation: state.generation + 1 })),
}));

registerSessionStore(() => usePurchaseActivitiesStore.getState().reset());

/**
 * Una escritura sin receptor cargado sería una petición contra el
 * contribuyente equivocado o un 400. Falla acá, que es donde se puede leer.
 */
function requireReceptor(receptorId: string | null): string {
  if (!receptorId) {
    throw new Error('No hay un contribuyente seleccionado.');
  }
  return receptorId;
}

function replaceActivity(
  activities: PurchaseActivity[],
  updated: PurchaseActivity,
): PurchaseActivity[] {
  return activities.map((activity) => (activity.id === updated.id ? updated : activity));
}

/** Mismo orden que devuelve la API: activas primero, después por nombre. */
function sortActivities(activities: PurchaseActivity[]): PurchaseActivity[] {
  return [...activities].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.nombre.localeCompare(b.nombre);
  });
}
