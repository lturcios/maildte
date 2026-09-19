import type {
  ApplyActivitySeedInput,
  ProposedActivity,
  ProposedSupplierMapping,
} from '@/types/domain';

/**
 * Edición de la propuesta de siembra ANTES de escribir nada (Addendum 11,
 * §"Siembra del catálogo y del mapeo").
 *
 * La siembra propone una actividad por cada `receptorCodActividad` distinto que
 * aparece en los DTE del receptor. Sobre el contribuyente real eso da cuatro
 * actividades, y la conclusión de la revisión de la fase 3 es que NO son
 * cuatro: `56101` "RESTAURANTES" y `56107` "Actividades varias de restaurantes"
 * son el mismo negocio con dos etiquetas, porque el código lo elige el
 * proveedor y no el comprador. El contador tiene que poder fusionarlas.
 *
 * La fusión ocurre acá, sobre el borrador, y no contra la base: el `apply` del
 * backend referencia la actividad POR NOMBRE, así que dos grupos de proveedores
 * que apunten al mismo nombre terminan en una sola fila del catálogo. Fusionar
 * después de escribir exigiría un `DELETE` que dejaría el mapeo apuntando al
 * vacío — precisamente lo que el addendum prohíbe.
 */
export interface SeedDraftActivity {
  /** Código propuesto. Es la clave del borrador y no cambia. */
  codActividad: string;
  /** Nombre editable: lo que el contador va a ver en el catálogo. */
  nombre: string;
  documentCount: number;
  /**
   * `codActividad` de la actividad que la absorbe, o `null` si sobrevive.
   * Fusionar no borra la fila del borrador: la redirige, para que el contador
   * pueda deshacerlo sin volver a pedir la propuesta.
   */
  mergedInto: string | null;
  /** Descartada: ni ella ni los proveedores que la declaran entran al lote. */
  discarded: boolean;
}

export function toDraft(activity: ProposedActivity): SeedDraftActivity {
  return {
    codActividad: activity.codActividad,
    nombre: activity.nombre,
    documentCount: activity.documentCount,
    mergedInto: null,
    discarded: false,
  };
}

/**
 * Sigue la cadena de fusiones hasta la actividad que sobrevive.
 *
 * Devuelve `null` si la cadena termina en una descartada o en un código que no
 * está en el borrador. El recorrido tiene guarda de ciclo: fusionar A en B y
 * después B en A es un par de clics, y sin la guarda serían un cuelgue del
 * navegador en vez de un error.
 */
export function resolveSurvivor(
  drafts: SeedDraftActivity[],
  codActividad: string,
): SeedDraftActivity | null {
  const byCode = new Map(drafts.map((draft) => [draft.codActividad, draft]));
  const seen = new Set<string>();

  let current = byCode.get(codActividad);
  while (current) {
    if (current.discarded) return null;
    if (current.mergedInto === null) return current;
    if (seen.has(current.codActividad)) return null;
    seen.add(current.codActividad);
    current = byCode.get(current.mergedInto);
  }
  return null;
}

/**
 * ¿Se puede fusionar `source` dentro de `target` sin cerrar un ciclo?
 *
 * Se rechaza si `target` ya termina —siguiendo su propia cadena— en `source`.
 */
export function canMerge(
  drafts: SeedDraftActivity[],
  sourceCode: string,
  targetCode: string,
): boolean {
  if (sourceCode === targetCode) return false;

  const byCode = new Map(drafts.map((draft) => [draft.codActividad, draft]));
  const seen = new Set<string>();

  let current = byCode.get(targetCode);
  while (current) {
    if (current.codActividad === sourceCode) return false;
    if (current.mergedInto === null) return true;
    if (seen.has(current.codActividad)) return false;
    seen.add(current.codActividad);
    current = byCode.get(current.mergedInto);
  }
  return false;
}

export interface SeedPayloadPreview {
  payload: ApplyActivitySeedInput;
  /** Proveedores que quedan fuera del lote por apuntar a una descartada. */
  droppedMappings: ProposedSupplierMapping[];
}

/**
 * Arma el lote definitivo a partir del borrador.
 *
 * Dos reglas que el backend no puede aplicar por nosotros:
 *
 * 1. **Las actividades salen deduplicadas por nombre.** Dos filas fusionadas
 *    con el mismo nombre serían dos entradas idénticas en el lote; el backend
 *    las saltearía por el `@@unique`, pero informaría un "salteado" que no es
 *    un salteado real y confundiría el resumen que ve el contador.
 * 2. **Un proveedor cuya actividad quedó descartada NO entra.** Mandarlo sin
 *    actividad válida sería un mapeo apuntando al vacío.
 */
export function buildSeedPayload(
  receptorId: string,
  drafts: SeedDraftActivity[],
  mappings: ProposedSupplierMapping[],
): SeedPayloadPreview {
  const survivors = drafts.filter((draft) => !draft.discarded && draft.mergedInto === null);

  const byName = new Map<string, { nombre: string; codActividad: string | null }>();
  for (const survivor of survivors) {
    const nombre = survivor.nombre.trim();
    if (nombre.length === 0 || byName.has(nombre)) continue;
    byName.set(nombre, { nombre, codActividad: survivor.codActividad });
  }

  const kept: ApplyActivitySeedInput['mappings'] = [];
  const droppedMappings: ProposedSupplierMapping[] = [];
  const seenEmisores = new Set<string>();

  for (const mapping of mappings) {
    const survivor = resolveSurvivor(drafts, mapping.codActividad);
    const nombre = survivor?.nombre.trim() ?? '';
    // `seenEmisores`: un proveedor tiene un solo default por receptor
    // (`@@unique([tenantId, receptorId, emisorId])`). Si dos filas de la
    // propuesta cayeran sobre el mismo emisor, mandar las dos sería pedirle al
    // backend que resuelva un empate que acá ya está resuelto por orden.
    if (!survivor || nombre.length === 0 || seenEmisores.has(mapping.emisorId)) {
      if (!survivor || nombre.length === 0) droppedMappings.push(mapping);
      continue;
    }
    seenEmisores.add(mapping.emisorId);
    kept.push({ emisorId: mapping.emisorId, activityNombre: nombre });
  }

  return {
    payload: {
      receptorId,
      confirm: true,
      activities: [...byName.values()],
      mappings: kept,
    },
    droppedMappings,
  };
}
