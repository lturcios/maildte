import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { apiPatch, apiPost, ApiError } from '@/lib/api-client';
import { todayUtcDate } from '@/lib/format';
import type {
  CreateAccountInput,
  SafeAccount,
  TestConnectionResult,
  UpdateAccountInput,
} from '@/types/domain';
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

interface AccountFormDialogProps {
  /** null = alta de cuenta nueva; un SafeAccount = edición. */
  account: SafeAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (account: SafeAccount) => void;
}

interface FormState {
  alias: string;
  email: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  mailbox: string;
  syncInterval: string;
  /** Solo aplica en alta (RF-02.2): editarla después no tiene efecto, por eso no está en modo edición. */
  syncFromDate: string;
}

function emptyForm(): FormState {
  return {
    alias: '',
    email: '',
    imapHost: '',
    imapPort: '993',
    imapSecure: true,
    imapUser: '',
    imapPassword: '',
    mailbox: 'INBOX',
    syncInterval: '300',
    syncFromDate: '',
  };
}

function formFromAccount(account: SafeAccount): FormState {
  return {
    alias: account.alias,
    email: account.email,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapSecure: account.imapSecure,
    imapUser: account.imapUser,
    imapPassword: '',
    mailbox: account.mailbox,
    syncInterval: String(account.syncInterval),
    syncFromDate: '',
  };
}

/**
 * Alta y edición de cuentas IMAP en un único diálogo.
 *
 * Formulario con estado simple de React (sin react-hook-form/zod): los
 * campos son pocos y la validación no trivial (puerto 1-65535, intervalo
 * mínimo) se resuelve con unos pocos checks antes de armar el payload — no
 * justifica la dependencia nueva, y mantiene el mismo patrón que LoginPage.
 *
 * El backend valida la conexión IMAP real dentro de POST/PATCH: no existe un
 * endpoint de "test" para una cuenta que todavía no existe, así que en modo
 * alta el botón "Guardar" ES el test de conexión (si falla con un error IMAP,
 * el diálogo queda abierto para reintentar). En modo edición se agrega
 * "Probar conexión" contra POST /accounts/:id/test.
 */
export function AccountFormDialog({
  account,
  open,
  onOpenChange,
  onSaved,
}: AccountFormDialogProps) {
  const isEditMode = account !== null;
  const [form, setForm] = useState<FormState>(() =>
    account ? formFromAccount(account) : emptyForm(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);

  // Reinicia el formulario cada vez que el diálogo pasa de cerrado a abierto
  // (para la misma cuenta o para una distinta). Se ajusta durante el render
  // en vez de en un efecto, siguiendo el patrón recomendado por React para
  // "adjusting state when a prop changes" (evita el round-trip de un efecto).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(account ? formFromAccount(account) : emptyForm());
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleTestConnection() {
    if (!account) {
      return;
    }
    setTesting(true);
    try {
      const response = await apiPost<{ data: TestConnectionResult }>(
        `/accounts/${account.id}/test`,
      );
      toast.success(`Conexión exitosa (${response.data.latencyMs} ms).`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo probar la conexión.');
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const portNumber = Number(form.imapPort);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      toast.error('El puerto IMAP debe ser un entero entre 1 y 65535.');
      return;
    }

    const trimmedInterval = form.syncInterval.trim();
    const syncIntervalNumber = trimmedInterval === '' ? undefined : Number(trimmedInterval);
    if (
      syncIntervalNumber !== undefined &&
      (!Number.isInteger(syncIntervalNumber) || syncIntervalNumber < 60)
    ) {
      toast.error('El intervalo de sincronización debe ser un entero de al menos 60 segundos.');
      return;
    }

    setSubmitting(true);
    try {
      if (isEditMode && account) {
        const payload: UpdateAccountInput = {};
        if (form.alias !== account.alias) payload.alias = form.alias;
        if (form.email !== account.email) payload.email = form.email;
        if (form.imapHost !== account.imapHost) payload.imapHost = form.imapHost;
        if (portNumber !== account.imapPort) payload.imapPort = portNumber;
        if (form.imapSecure !== account.imapSecure) payload.imapSecure = form.imapSecure;
        if (form.imapUser !== account.imapUser) payload.imapUser = form.imapUser;
        if (form.imapPassword.trim() !== '') payload.imapPassword = form.imapPassword;
        if (form.mailbox !== account.mailbox) payload.mailbox = form.mailbox;
        if (syncIntervalNumber !== undefined && syncIntervalNumber !== account.syncInterval) {
          payload.syncInterval = syncIntervalNumber;
        }

        if (Object.keys(payload).length === 0) {
          onOpenChange(false);
          return;
        }

        const response = await apiPatch<{ data: SafeAccount }>(`/accounts/${account.id}`, payload);
        onSaved(response.data);
        toast.success('Cuenta actualizada.');
        onOpenChange(false);
      } else {
        const payload: CreateAccountInput = {
          alias: form.alias,
          email: form.email,
          imapHost: form.imapHost,
          imapPort: portNumber,
          imapSecure: form.imapSecure,
          imapUser: form.imapUser,
          imapPassword: form.imapPassword,
          ...(form.mailbox.trim() !== '' ? { mailbox: form.mailbox.trim() } : {}),
          ...(syncIntervalNumber !== undefined ? { syncInterval: syncIntervalNumber } : {}),
          ...(form.syncFromDate !== ''
            ? { syncFromDate: new Date(`${form.syncFromDate}T00:00:00Z`).toISOString() }
            : {}),
        };
        const response = await apiPost<{ data: SafeAccount }>('/accounts', payload);
        onSaved(response.data);
        toast.success('Cuenta creada.');
        onOpenChange(false);
      }
    } catch (error) {
      // El diálogo queda abierto a propósito para que el usuario pueda corregir y reintentar.
      toast.error(error instanceof ApiError ? error.message : 'No se pudo guardar la cuenta.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Editar cuenta' : 'Nueva cuenta IMAP'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Los cambios de credenciales se validan contra el servidor IMAP antes de guardarse.'
              : 'La conexión IMAP se valida al guardar; si falla, la cuenta no se crea.'}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="alias">Alias</Label>
              <Input
                id="alias"
                required
                maxLength={120}
                value={form.alias}
                onChange={(event) => update('alias', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Correo</Label>
              <Input
                id="email"
                type="email"
                required
                value={form.email}
                onChange={(event) => update('email', event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="imapHost">Servidor IMAP</Label>
              <Input
                id="imapHost"
                required
                maxLength={255}
                placeholder="imap.ejemplo.com"
                value={form.imapHost}
                onChange={(event) => update('imapHost', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="imapPort">Puerto</Label>
              <Input
                id="imapPort"
                type="number"
                min={1}
                max={65535}
                required
                className="w-24"
                value={form.imapPort}
                onChange={(event) => update('imapPort', event.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={form.imapSecure}
              onChange={(event) => update('imapSecure', event.target.checked)}
            />
            Usar TLS/SSL (IMAPS)
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="imapUser">Usuario IMAP</Label>
              <Input
                id="imapUser"
                required
                maxLength={255}
                value={form.imapUser}
                onChange={(event) => update('imapUser', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="imapPassword">
                {isEditMode ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña IMAP'}
              </Label>
              <Input
                id="imapPassword"
                type="password"
                autoComplete="new-password"
                required={!isEditMode}
                value={form.imapPassword}
                onChange={(event) => update('imapPassword', event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="mailbox">Buzón (opcional)</Label>
              <Input
                id="mailbox"
                maxLength={255}
                placeholder="INBOX"
                value={form.mailbox}
                onChange={(event) => update('mailbox', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="syncInterval">Intervalo de sync (segundos)</Label>
              <Input
                id="syncInterval"
                type="number"
                min={60}
                value={form.syncInterval}
                onChange={(event) => update('syncInterval', event.target.value)}
              />
            </div>
          </div>

          {!isEditMode && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="syncFromDate">Sincronizar desde (opcional)</Label>
              <Input
                id="syncFromDate"
                type="date"
                max={todayUtcDate()}
                value={form.syncFromDate}
                onChange={(event) => update('syncFromDate', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Solo aplica a la primera sincronización. Si se deja vacío, arranca desde ahora.
              </p>
            </div>
          )}

          <DialogFooter className="items-center sm:justify-between">
            {isEditMode ? (
              <Button
                type="button"
                variant="outline"
                disabled={testing || submitting}
                onClick={() => void handleTestConnection()}
              >
                {testing ? 'Probando…' : 'Probar conexión'}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
