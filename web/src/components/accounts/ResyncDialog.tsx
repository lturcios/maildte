import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { apiPost, ApiError } from '@/lib/api-client';
import { todayUtcDate } from '@/lib/format';
import type { ResyncAccountInput, SafeAccount, TriggerSyncResult } from '@/types/domain';
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

interface ResyncDialogProps {
  /** null = diálogo cerrado. */
  account: SafeAccount | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cambia syncFromDate y fuerza que la cuenta vuelva a recorrer el buzón
 * desde esa fecha (POST /accounts/:id/resync) — ver AccountsService.resyncFrom.
 * Reprocesar es seguro: los correos ya archivados se detectan como
 * duplicados por (accountId, messageId) y no se vuelven a descargar.
 */
export function ResyncDialog({ account, onOpenChange }: ResyncDialogProps) {
  const [date, setDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Limpia el campo de fecha cada vez que el diálogo se abre para una cuenta
  // distinta (mismo patrón de "ajustar estado durante el render" que AccountFormDialog).
  const [lastAccountId, setLastAccountId] = useState<string | null>(null);
  if ((account?.id ?? null) !== lastAccountId) {
    setLastAccountId(account?.id ?? null);
    if (account) {
      setDate('');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || !date) {
      return;
    }
    setSubmitting(true);
    try {
      const payload: ResyncAccountInput = {
        syncFromDate: new Date(`${date}T00:00:00Z`).toISOString(),
      };
      const response = await apiPost<{ data: TriggerSyncResult }>(
        `/accounts/${account.id}/resync`,
        payload,
      );
      if (response.data.enqueued) {
        toast.success(`Re-sincronización de "${account.alias}" encolada desde ${date}.`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo encolar la re-sincronización.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Re-sincronizar "{account?.alias}"</DialogTitle>
          <DialogDescription>
            Vuelve a recorrer el buzón completo desde la fecha indicada. Los correos que ya
            archivaste no se descargan de nuevo; según el rango, puede tardar.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="resyncDate">Sincronizar desde</Label>
            <Input
              id="resyncDate"
              type="date"
              required
              max={todayUtcDate()}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting || !date}>
              {submitting ? 'Encolando…' : 'Re-sincronizar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
