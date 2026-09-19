import type { ResolvedActivity } from '@/types/domain';

/**
 * Actividad efectiva de una compra, con su origen (Addendum 11, §7.4).
 *
 * Mostrar el origen y no solo el nombre es lo que hace útil esta celda. Una
 * actividad **heredada** del proveedor se corrige para TODAS sus compras
 * mapeando ese proveedor una vez; un **override** es una decisión tomada sobre
 * esa compra puntual y solo se cambia ahí. Con el nombre solo, las dos se ven
 * igual y el contador no sabe dónde tiene que ir a corregir.
 */
export function ActivityBadge({ resolved }: { resolved: ResolvedActivity | null }) {
  if (!resolved || resolved.source === 'missing') {
    return (
      <span className="text-xs text-muted-foreground" title="Sin actividad resuelta">
        Sin actividad
      </span>
    );
  }

  const nombre = resolved.activity?.nombre ?? 'Actividad no encontrada';
  const esOverride = resolved.source === 'override';

  return (
    <span className="flex flex-col gap-0.5">
      <span className="block max-w-32 truncate text-sm" title={nombre}>
        {nombre}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {esOverride ? 'Propia de esta compra' : 'Del proveedor'}
      </span>
    </span>
  );
}
