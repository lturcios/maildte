import { useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiPost, ApiError } from '@/lib/api-client';
import type { ReprocessInput, ReprocessMode, ReprocessResult } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MODE_OPTIONS: { value: ReprocessMode; label: string; description: string }[] = [
  {
    value: 'missing',
    label: 'Solo los pendientes',
    description:
      'Procesa los archivos JSON que todavía no entraron al libro. Es la opción normal después de un despliegue o si el servicio de colas estuvo caído.',
  },
  {
    value: 'failed',
    label: 'Pendientes y fallidos',
    description:
      'Agrega los que quedaron con error y los procesados con una versión anterior del lector de DTE.',
  },
  {
    value: 'all',
    label: 'Todo el período',
    description:
      'Vuelve a leer todos los archivos del filtro. La clasificación manual de las columnas Q a T se conserva.',
  },
];

/** Tope de vueltas del bucle: evita un ciclo infinito si el cursor no avanzara. */
const MAX_PAGES = 200;

interface ReprocessButtonProps {
  /** Cuenta actualmente filtrada, para acotar el reprocesamiento. */
  accountId?: string;
  /** Mes filtrado (`YYYY-MM`), si lo hay. */
  month?: string;
  onFinished: () => void;
}

/**
 * Reprocesamiento del libro de compras (Addendum 10, §6.6). Solo ADMIN.
 *
 * El endpoint responde por páginas con un cursor, así que el botón itera hasta
 * agotarlas. No toca el buzón ni el estado de sincronización: solo vuelve a
 * leer archivos ya descargados, así que repetirlo es seguro.
 */
export function ReprocessButton({ accountId, month, onFinished }: ReprocessButtonProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ReprocessMode>('missing');
  const [running, setRunning] = useState(false);

  const selected = MODE_OPTIONS.find((option) => option.value === mode);

  async function handleConfirm() {
    setRunning(true);
    try {
      let cursor: string | null = null;
      let enqueued = 0;
      let pages = 0;

      do {
        const body: ReprocessInput = { mode };
        if (accountId) body.accountId = accountId;
        if (month) body.month = month;
        if (cursor) body.cursor = cursor;

        const response: { data: ReprocessResult } = await apiPost<{ data: ReprocessResult }>(
          '/purchase-book/reprocess',
          body,
        );
        enqueued += response.data.enqueued;
        cursor = response.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < MAX_PAGES);

      setOpen(false);
      if (enqueued === 0) {
        toast.info('No hay archivos pendientes de procesar con ese criterio.');
      } else {
        toast.success(
          enqueued === 1
            ? '1 archivo encolado. El libro se actualiza en segundo plano.'
            : `${enqueued} archivos encolados. El libro se actualiza en segundo plano.`,
        );
      }
      onFinished();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo iniciar el reprocesamiento.',
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11">
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          Reprocesar
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reprocesar archivos DTE</AlertDialogTitle>
          <AlertDialogDescription>
            Vuelve a leer los archivos JSON ya descargados y los incorpora al libro de compras. No
            se conecta al buzón ni modifica los correos.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="reprocess-mode">Alcance</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as ReprocessMode)}>
            <SelectTrigger id="reprocess-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
          {(accountId || month) && (
            <p className="text-xs text-muted-foreground">
              Se aplicará solo a {accountId ? 'la cuenta' : ''}
              {accountId && month ? ' y ' : ''}
              {month ? `el período ${month}` : ''} del filtro actual.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancelar</AlertDialogCancel>
          <Button type="button" disabled={running} onClick={() => void handleConfirm()}>
            {running ? 'Encolando…' : 'Reprocesar'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
