import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiGet, apiPatch, ApiError } from '@/lib/api-client';
import type { PurchaseActivity, PurchaseDocumentDetail } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Valor centinela: "sin override, que mande el default del proveedor". */
const DEL_PROVEEDOR = 'supplier-default';

interface ActivityEditorProps {
  document: PurchaseDocumentDetail;
  canEdit: boolean;
  onSaved: (updated: PurchaseDocumentDetail) => void;
}

/**
 * Override de la actividad económica de UNA compra (Addendum 11, §7.4).
 *
 * Es la punta de la cascada `override > default del proveedor > sin
 * clasificar`. Se usa cuando un proveedor que normalmente abastece a una unidad
 * de negocio, en esta compra puntual sirvió a otra.
 *
 * El catálogo se pide acá y no se cachea en un store: cada compra puede ser de
 * un receptor distinto, y el catálogo es POR CONTRIBUYENTE. Un caché compartido
 * entre compras de receptores distintos ofrecería asignar la actividad de una
 * empresa a las compras de otra — el 422 del backend lo impediría, pero
 * ofrecerlo en un select ya es un error de diseño.
 */
export function ActivityEditor({ document, canEdit, onSaved }: ActivityEditorProps) {
  const [activities, setActivities] = useState<PurchaseActivity[]>([]);
  // Arranca cargando solo si hay algo que cargar: un MIEMBRO no pide el
  // catálogo, y así el efecto no necesita un `setLoading(false)` suelto.
  const [loading, setLoading] = useState(canEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const receptorId = document.receptor.id;

  useEffect(() => {
    if (!canEdit) return;

    let cancelado = false;
    void (async () => {
      try {
        const response = await apiGet<{ data: PurchaseActivity[] }>(
          `/purchase-book/activities?receptorId=${receptorId}`,
        );
        if (!cancelado) setActivities(response.data);
      } catch (err) {
        if (!cancelado) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'No se pudo cargar el catálogo de actividad del contribuyente.',
          );
        }
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [receptorId, canEdit]);

  async function handleChange(value: string) {
    const activityId = value === DEL_PROVEEDOR ? null : value;

    setSaving(true);
    try {
      const response = await apiPatch<{ data: PurchaseDocumentDetail }>(
        `/purchase-book/documents/${document.id}/activity`,
        { activityId },
      );
      onSaved(response.data);
      toast.success(
        activityId === null
          ? 'Se quitó la actividad propia: la compra vuelve a heredar la del proveedor.'
          : 'Actividad de la compra actualizada.',
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'No se pudo cambiar la actividad de la compra.',
      );
    } finally {
      setSaving(false);
    }
  }

  const resolved = document.resolvedActivity;
  const heredada = resolved?.source === 'supplier-default' ? resolved.activity : null;

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        {resolved && resolved.source !== 'missing'
          ? `${resolved.activity?.nombre ?? '—'} · ${resolved.source === 'override' ? 'propia de esta compra' : 'heredada del proveedor'}`
          : 'Sin actividad asignada.'}{' '}
        Solo un administrador puede cambiarla.
      </p>
    );
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  const activas = activities.filter((activity) => activity.active);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5 sm:max-w-sm">
        <Label htmlFor="document-activity">Actividad de esta compra</Label>
        <Select
          value={document.activityId ?? DEL_PROVEEDOR}
          disabled={loading || saving}
          onValueChange={(value) => void handleChange(value)}
        >
          <SelectTrigger id="document-activity" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEL_PROVEEDOR}>
              {heredada ? `Heredar del proveedor (${heredada.nombre})` : 'Heredar del proveedor'}
            </SelectItem>
            {activas.map((activity) => (
              <SelectItem key={activity.id} value={activity.id}>
                {activity.nombre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activas.length === 0 && !loading && (
        <p className="text-xs text-muted-foreground">
          Este contribuyente todavía no tiene actividades en su catálogo. Creálas desde Libro de
          compras → Actividades.
        </p>
      )}

      {resolved?.source === 'supplier-default' && (
        <p className="text-xs text-muted-foreground">
          Hoy la hereda de su proveedor. Si TODAS las compras de este proveedor van a otra
          actividad, conviene cambiar el mapeo del proveedor en vez de corregir compra por compra.
        </p>
      )}

      {document.activityId !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={saving}
          onClick={() => void handleChange(DEL_PROVEEDOR)}
        >
          Quitar la actividad propia
        </Button>
      )}
    </div>
  );
}
