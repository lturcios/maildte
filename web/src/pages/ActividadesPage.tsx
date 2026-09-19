import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeftIcon, PlusIcon, SparklesIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { useDtePartiesStore } from '@/stores/dte-parties-store';
import { usePurchaseActivitiesStore } from '@/stores/purchase-activities-store';
import type { PurchaseActivity, SupplierActivityDefault } from '@/types/domain';
import { ActivitySeedDialog } from '@/components/purchase-book/ActivitySeedDialog';
import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Valor centinela del select de mapeo: "este proveedor no tiene default". */
const SIN_ACTIVIDAD = 'none';

/**
 * Catálogo de actividad económica y mapeo de proveedores (Addendum 11, fase 3).
 *
 * La actividad NO viene en el DTE. `receptorCodActividad` lo escribe el emisor
 * copiándolo del registro de Hacienda, así que dice "cómo está inscripto el
 * comprador", no "a qué unidad de negocio va esta compra" — que es lo único
 * que sirve para contabilidad interna y lo único que el proveedor no puede
 * saber. Por eso la actividad se declara acá: una vez por proveedor, y se
 * corrige compra por compra solo cuando ese proveedor sirvió a otra unidad.
 *
 * Todo cuelga de un receptor. El catálogo es POR CONTRIBUYENTE y el mapeo es
 * ternario: el mismo distribuidor le vende a varios clientes del mismo buzón y
 * a cada uno le sirve un negocio distinto.
 */
export function ActividadesPage() {
  const receptores = useDtePartiesStore((state) => state.byRole.RECEPTOR.parties);
  const receptoresLoading = useDtePartiesStore((state) => state.byRole.RECEPTOR.loading);
  const fetchParties = useDtePartiesStore((state) => state.fetchParties);

  const receptorId = usePurchaseActivitiesStore((state) => state.receptorId);
  const activities = usePurchaseActivitiesStore((state) => state.activities);
  const mappings = usePurchaseActivitiesStore((state) => state.mappings);
  const loading = usePurchaseActivitiesStore((state) => state.loading);
  const error = usePurchaseActivitiesStore((state) => state.error);
  const load = usePurchaseActivitiesStore((state) => state.load);
  const createActivity = usePurchaseActivitiesStore((state) => state.createActivity);
  const updateActivity = usePurchaseActivitiesStore((state) => state.updateActivity);
  const deactivateActivity = usePurchaseActivitiesStore((state) => state.deactivateActivity);
  const removeActivity = usePurchaseActivitiesStore((state) => state.removeActivity);
  const setSupplierDefault = usePurchaseActivitiesStore((state) => state.setSupplierDefault);
  const clearSupplierDefault = usePurchaseActivitiesStore((state) => state.clearSupplierDefault);

  const [nuevoNombre, setNuevoNombre] = useState('');
  const [creando, setCreando] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);

  useEffect(() => {
    void fetchParties('RECEPTOR');
  }, [fetchParties]);

  const receptor = useMemo(
    () => receptores.find((party) => party.id === receptorId) ?? null,
    [receptores, receptorId],
  );

  /** Solo las activas se pueden asignar a un proveedor. */
  const asignables = useMemo(() => activities.filter((a) => a.active), [activities]);

  async function run(id: string | null, action: () => Promise<unknown>, fallback: string) {
    setBusyId(id);
    try {
      await action();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusyId(null);
    }
  }

  async function handleCrear() {
    const nombre = nuevoNombre.trim();
    if (!receptorId || nombre.length === 0) return;

    setCreando(true);
    try {
      await createActivity({ receptorId, nombre });
      setNuevoNombre('');
      toast.success(`Actividad «${nombre}» creada.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la actividad.');
    } finally {
      setCreando(false);
    }
  }

  /**
   * Borrar solo se ofrece de verdad cuando nada la referencia. Si algo la usa,
   * la API responde 422 y dirige a desactivar: borrarla dejaría el mapeo de un
   * proveedor apuntando a una actividad inexistente.
   */
  async function handleBorrar(activity: PurchaseActivity) {
    await run(activity.id, () => removeActivity(activity.id), 'No se pudo eliminar la actividad.');
  }

  async function handleMapear(mapping: SupplierActivityDefault, value: string) {
    if (value === SIN_ACTIVIDAD) {
      await run(
        mapping.emisorId,
        () => clearSupplierDefault(mapping.emisorId),
        'No se pudo quitar la actividad del proveedor.',
      );
      return;
    }
    await run(
      mapping.emisorId,
      () => setSupplierDefault(mapping.emisorId, value),
      'No se pudo asignar la actividad al proveedor.',
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          to="/libro-compras"
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Volver al libro de compras
        </Link>
        <h1 className="font-display text-2xl font-semibold">Actividades por contribuyente</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Si un cliente opera varias unidades de negocio —un restaurante y un catering, dos
          locales—, acá se declaran y se dice qué proveedor abastece a cuál. La actividad no viene
          en el DTE: el código que traen los comprobantes lo elige el proveedor y dice cómo está
          inscripto el comprador, no a qué negocio va cada compra.
        </p>
      </header>

      <div className="flex flex-col gap-1.5 sm:max-w-md">
        <Label htmlFor="actividades-receptor">Contribuyente</Label>
        <Select
          value={receptorId ?? ''}
          disabled={receptoresLoading}
          onValueChange={(value) => void load(value)}
        >
          <SelectTrigger id="actividades-receptor" className="w-full">
            <SelectValue placeholder="Elegí un contribuyente" />
          </SelectTrigger>
          <SelectContent>
            {receptores.map((party) => (
              <SelectItem key={party.id} value={party.id}>
                {party.nombre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!receptorId && (
        <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          Elegí un contribuyente para ver su catálogo. Las actividades y el mapeo de proveedores son
          de cada cliente por separado: el criterio de una empresa no se aplica a las compras de
          otra.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </p>
      )}

      {receptorId && loading && <Skeleton className="h-40 w-full" />}

      {receptorId && !loading && !error && receptor && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold">Catálogo</h2>
              <Button type="button" variant="outline" onClick={() => setSeedOpen(true)}>
                <SparklesIcon className="size-4" aria-hidden="true" />
                Sembrar desde las compras
              </Button>
            </div>

            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCrear();
              }}
            >
              <div className="flex min-w-56 flex-1 flex-col gap-1.5">
                <Label htmlFor="nueva-actividad">Nueva actividad</Label>
                <Input
                  id="nueva-actividad"
                  value={nuevoNombre}
                  placeholder="Restaurante, Catering, Local centro…"
                  onChange={(event) => setNuevoNombre(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={creando || nuevoNombre.trim().length === 0}>
                <PlusIcon className="size-4" aria-hidden="true" />
                Agregar
              </Button>
            </form>

            {activities.length === 0 ? (
              <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                Este contribuyente todavía no tiene actividades. Sembrá el catálogo desde sus
                compras o creá la primera a mano.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actividad</TableHead>
                      <TableHead>Código</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activities.map((activity) => (
                      <TableRow key={activity.id}>
                        <TableCell className="font-medium">{activity.nombre}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {activity.codActividad ?? '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {activity.active ? 'Activa' : 'Retirada'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {activity.active ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busyId === activity.id}
                                onClick={() =>
                                  void run(
                                    activity.id,
                                    () => deactivateActivity(activity.id),
                                    'No se pudo retirar la actividad.',
                                  )
                                }
                              >
                                Retirar
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busyId === activity.id}
                                onClick={() =>
                                  void run(
                                    activity.id,
                                    () => updateActivity(activity.id, { active: true }),
                                    'No se pudo reactivar la actividad.',
                                  )
                                }
                              >
                                Reactivar
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busyId === activity.id}
                              aria-label={`Eliminar ${activity.nombre}`}
                              onClick={() => void handleBorrar(activity)}
                            >
                              <XIcon className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-semibold">Proveedores</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Ordenados por volumen de compras: mapear los primeros ya cubre casi todo. Lo que
              definas acá lo hereda cada compra de ese proveedor, salvo que la compra tenga su
              propia actividad asignada.
            </p>

            {mappings.length === 0 ? (
              <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                Ningún proveedor tiene actividad asignada todavía. La siembra los mapea de una vez a
                partir de lo que declaran sus comprobantes.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Proveedor</TableHead>
                      <TableHead className="text-right">Compras</TableHead>
                      <TableHead>Actividad</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.map((mapping) => (
                      <TableRow key={mapping.id}>
                        <TableCell>
                          <span className="block font-medium">{mapping.emisor.nombre}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {mapping.emisor.nit}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {mapping.documentCount}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={mapping.activityId}
                            disabled={busyId === mapping.emisorId}
                            onValueChange={(value) => void handleMapear(mapping, value)}
                          >
                            <SelectTrigger
                              className="w-full min-w-48"
                              aria-label={`Actividad de ${mapping.emisor.nombre}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SIN_ACTIVIDAD}>Sin actividad</SelectItem>
                              {asignables.map((activity) => (
                                <SelectItem key={activity.id} value={activity.id}>
                                  {activity.nombre}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {/*
            Montado solo mientras está abierto: así cada apertura pide la
            propuesta de nuevo y el borrador de fusiones nace limpio. Dejarlo
            montado arrastraría las decisiones de la sesión anterior, o peor,
            las de otro contribuyente.
          */}
          {seedOpen && (
            <ActivitySeedDialog
              receptorId={receptorId}
              receptorNombre={receptor.nombre}
              open
              onOpenChange={setSeedOpen}
            />
          )}
        </>
      )}
    </div>
  );
}
