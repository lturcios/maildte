import { useCallback, useEffect, useState } from 'react';
import { MergeIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import {
  buildSeedPayload,
  canMerge,
  resolveSurvivor,
  toDraft,
  type SeedDraftActivity,
} from '@/lib/activity-seed';
import { usePurchaseActivitiesStore } from '@/stores/purchase-activities-store';
import type { ActivitySeedProposal } from '@/types/domain';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/** Valor centinela del select de fusión: "esta actividad queda sola". */
const SIN_FUSIONAR = 'none';

interface ActivitySeedDialogProps {
  receptorId: string;
  receptorNombre: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Siembra del catálogo de actividad (Addendum 11, fase 3).
 *
 * Es lo que convierte la carga inicial en un trabajo de minutos: propone una
 * actividad por cada código que los proveedores declararon y mapea cada
 * proveedor al que declara con más frecuencia.
 *
 * La propuesta NO se aplica tal cual, y ese es el punto. La revisión de la fase
 * 3 midió que un solo restaurante aparecía con cuatro códigos porque el código
 * lo elige el emisor, no el comprador. Fusionar y descartar tiene que pasar
 * ANTES de escribir: el `apply` referencia la actividad por nombre, así que dos
 * grupos de proveedores que apunten al mismo nombre terminan en una sola fila.
 * Fusionar después exigiría un borrado que dejaría el mapeo apuntando al vacío.
 */
export function ActivitySeedDialog({
  receptorId,
  receptorNombre,
  open,
  onOpenChange,
}: ActivitySeedDialogProps) {
  const proposeSeed = usePurchaseActivitiesStore((state) => state.proposeSeed);
  const applySeed = usePurchaseActivitiesStore((state) => state.applySeed);

  const [proposal, setProposal] = useState<ActivitySeedProposal | null>(null);
  const [drafts, setDrafts] = useState<SeedDraftActivity[]>([]);
  // Arranca en `true` porque la propuesta se pide al montar: inicializarlo en
  // `false` obligaría a un `setLoading(true)` suelto dentro del efecto.
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * La propuesta se pide al MONTAR, no en el `onOpenChange` del diálogo.
   *
   * `open` llega por prop desde la página, y Radix dispara `onOpenChange`
   * cuando el usuario interactúa con el propio diálogo — no cuando el padre lo
   * abre. Colgar la carga de ahí dejaba el diálogo abierto y vacío para
   * siempre.
   *
   * Y no hay rama de limpieza: la página monta este componente solo mientras
   * está abierto, así que cerrarlo lo desmonta y el borrador se va con él. Una
   * propuesta vieja no puede sobrevivir a un cambio de contribuyente.
   */
  useEffect(() => {
    let cancelado = false;

    void (async () => {
      try {
        const data = await proposeSeed(receptorId);
        if (cancelado) return;
        setProposal(data);
        setDrafts(data.activities.map(toDraft));
      } catch (err) {
        if (cancelado) return;
        setError(
          err instanceof ApiError ? err.message : 'No se pudo calcular la propuesta de siembra.',
        );
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();

    // Cerrar el diálogo mientras la propuesta viaja no puede pintarla después.
    return () => {
      cancelado = true;
    };
  }, [receptorId, proposeSeed]);

  const handleOpenChange = useCallback((next: boolean) => onOpenChange(next), [onOpenChange]);

  function updateDraft(codActividad: string, patch: Partial<SeedDraftActivity>) {
    setDrafts((prev) =>
      prev.map((draft) => (draft.codActividad === codActividad ? { ...draft, ...patch } : draft)),
    );
  }

  async function handleApply() {
    if (!proposal) return;

    const { payload, droppedMappings } = buildSeedPayload(receptorId, drafts, proposal.mappings);
    if (payload.activities.length === 0) {
      toast.error('No queda ninguna actividad que sembrar: revisá las fusiones y los descartes.');
      return;
    }

    setApplying(true);
    try {
      const result = await applySeed(payload);
      const partes = [
        `${result.activitiesCreated} actividad(es)`,
        `${result.mappingsCreated} proveedor(es) mapeado(s)`,
      ];
      if (result.activitiesSkipped > 0 || result.mappingsSkipped > 0) {
        partes.push(
          `${result.activitiesSkipped + result.mappingsSkipped} ya existían y no se tocaron`,
        );
      }
      if (droppedMappings.length > 0) {
        partes.push(`${droppedMappings.length} proveedor(es) sin actividad quedaron sin mapear`);
      }
      toast.success(`Catálogo sembrado: ${partes.join(', ')}.`);
      handleOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo sembrar el catálogo.');
    } finally {
      setApplying(false);
    }
  }

  const supervivientes = drafts.filter((draft) => !draft.discarded && draft.mergedInto === null);
  const preview = proposal ? buildSeedPayload(receptorId, drafts, proposal.mappings) : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sembrar el catálogo de {receptorNombre}</DialogTitle>
          <DialogDescription>
            Cada código que los proveedores declararon se propone como una actividad. El código lo
            elige el proveedor, no vos: es habitual que el mismo negocio aparezca con varias
            etiquetas. Fusioná las que sean lo mismo y descartá las que no sirvan antes de aplicar.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {error}
          </p>
        )}

        {proposal && !loading && (
          <div className="flex flex-col gap-4">
            {proposal.activities.length === 0 ? (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                Ninguna compra de este contribuyente declara una actividad económica, así que no hay
                nada que proponer. Podés crear las actividades a mano y mapear los proveedores uno
                por uno.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {drafts.map((draft) => {
                  const survivor = resolveSurvivor(drafts, draft.codActividad);
                  const fusionada = draft.mergedInto !== null;
                  const inactiva = draft.discarded || fusionada;

                  return (
                    <li
                      key={draft.codActividad}
                      className={`rounded-lg border border-border p-3 ${inactiva ? 'opacity-60' : ''}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            {draft.codActividad}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {draft.documentCount} compra(s)
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {draft.discarded ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => updateDraft(draft.codActividad, { discarded: false })}
                            >
                              <RotateCcwIcon className="size-4" aria-hidden="true" />
                              Recuperar
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Descartar ${draft.nombre}`}
                              onClick={() =>
                                updateDraft(draft.codActividad, {
                                  discarded: true,
                                  mergedInto: null,
                                })
                              }
                            >
                              <Trash2Icon className="size-4" aria-hidden="true" />
                              Descartar
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`seed-nombre-${draft.codActividad}`} className="text-xs">
                            Nombre de la actividad
                          </Label>
                          <Input
                            id={`seed-nombre-${draft.codActividad}`}
                            value={draft.nombre}
                            disabled={inactiva}
                            onChange={(event) =>
                              updateDraft(draft.codActividad, { nombre: event.target.value })
                            }
                          />
                        </div>

                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`seed-fusion-${draft.codActividad}`} className="text-xs">
                            Es lo mismo que
                          </Label>
                          <Select
                            value={draft.mergedInto ?? SIN_FUSIONAR}
                            disabled={draft.discarded}
                            onValueChange={(value) =>
                              updateDraft(draft.codActividad, {
                                mergedInto: value === SIN_FUSIONAR ? null : value,
                              })
                            }
                          >
                            <SelectTrigger
                              id={`seed-fusion-${draft.codActividad}`}
                              aria-label={`Fusionar ${draft.nombre}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SIN_FUSIONAR}>Es una actividad propia</SelectItem>
                              {drafts
                                .filter(
                                  (other) =>
                                    !other.discarded &&
                                    canMerge(drafts, draft.codActividad, other.codActividad),
                                )
                                .map((other) => (
                                  <SelectItem key={other.codActividad} value={other.codActividad}>
                                    {other.nombre}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {fusionada && survivor && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <MergeIcon className="size-3.5" aria-hidden="true" />
                          Sus proveedores van a quedar en «{survivor.nombre}».
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p>
                Se van a crear <strong>{supervivientes.length}</strong> actividad(es) y a mapear{' '}
                <strong>{preview?.payload.mappings.length ?? 0}</strong> proveedor(es).
              </p>
              {preview && preview.droppedMappings.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  {preview.droppedMappings.length} proveedor(es) quedan sin mapear porque su
                  actividad fue descartada. Podés mapearlos a mano después.
                </p>
              )}
              {proposal.documentsWithoutActivity > 0 && (
                <p className="mt-1 text-muted-foreground">
                  {proposal.documentsWithoutActivity} compra(s) no declaran actividad y no
                  participan de la propuesta.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={applying || loading || supervivientes.length === 0}
            onClick={() => void handleApply()}
          >
            {applying ? 'Sembrando…' : 'Aplicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
