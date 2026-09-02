import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiGet, apiPatch, apiPost, ApiError } from '@/lib/api-client';
import { todayUtcDate } from '@/lib/format';
import { resolveAccountEndpoint } from '@/lib/imap-endpoint';
import { useMailProvidersStore } from '@/stores/mail-providers-store';
import type {
  AccountMailProvider,
  CreateAccountInput,
  ResolveProviderResult,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AccountFormDialogProps {
  /** null = alta de cuenta nueva; un SafeAccount = edición. */
  account: SafeAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (account: SafeAccount) => void;
}

/**
 * Valor del Select para "servidor personalizado". Radix no admite un SelectItem
 * con value="", así que el caso "sin perfil" necesita un centinela explícito.
 */
const CUSTOM_PROVIDER = 'custom';

interface FormState {
  alias: string;
  email: string;
  /** Id del perfil del catálogo, o CUSTOM_PROVIDER para cargar el servidor a mano. */
  providerId: string;
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
    providerId: CUSTOM_PROVIDER,
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
  // Los campos manuales se precargan con el endpoint EFECTIVO, no con las
  // columnas de la cuenta: si está vinculada a un perfil, esas columnas pueden
  // haber quedado atrás respecto del catálogo. Así, desvincular conserva lo que
  // realmente está corriendo hoy.
  const effective = resolveAccountEndpoint(account);

  return {
    alias: account.alias,
    email: account.email,
    providerId: account.providerId ?? CUSTOM_PROVIDER,
    imapHost: effective.imapHost,
    imapPort: String(effective.imapPort),
    imapSecure: effective.imapSecure,
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
 * Servicio de correo (Addendum 09): al salir del campo de correo se consulta
 * GET /mail-providers/resolve, que infiere el proveedor por el dominio o por el
 * registro MX. La sugerencia se aplica sola mientras el usuario no haya tocado
 * el desplegable; a partir de ahí manda su elección. Elegir un perfil oculta
 * host/puerto/TLS porque esos valores pasan a salir del catálogo en cada
 * sincronización.
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

  const providers = useMailProvidersStore((state) => state.providers);
  const fetchProviders = useMailProvidersStore((state) => state.fetchProviders);

  /** Resultado de la última detección automática, para la leyenda y la advertencia. */
  const [detected, setDetected] = useState<ResolveProviderResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** Una vez que el usuario elige a mano, la detección no vuelve a pisarle la elección. */
  const [providerTouched, setProviderTouched] = useState(false);

  useEffect(() => {
    void fetchProviders();
  }, [fetchProviders]);

  // Reinicia el formulario cada vez que el diálogo pasa de cerrado a abierto
  // (para la misma cuenta o para una distinta). Se ajusta durante el render
  // en vez de en un efecto, siguiendo el patrón recomendado por React para
  // "adjusting state when a prop changes" (evita el round-trip de un efecto).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(account ? formFromAccount(account) : emptyForm());
      setDetected(null);
      setProviderTouched(false);
    }
  }

  /**
   * Perfil vinculado que ya no está en el catálogo activo: pasa si el SUPERADMIN
   * lo deshabilitó después. La cuenta sigue funcionando (deshabilitar no corta
   * el vínculo, ADR-09.1), así que hay que ofrecerlo igual en el desplegable y
   * avisar — si no, el select queda vacío y el formulario mostraría los campos
   * de servidor manual para una cuenta que en realidad usa un perfil.
   */
  const linkedButInactive =
    isEditMode &&
    account.provider !== null &&
    form.providerId === account.providerId &&
    !providers.some((item) => item.id === account.providerId)
      ? account.provider
      : null;

  // Solo se leen los campos comunes a AccountMailProvider, así que el perfil
  // deshabilitado (que viene anidado en la cuenta, sin dominios) sirve igual.
  const selectedProvider: AccountMailProvider | null =
    form.providerId === CUSTOM_PROVIDER
      ? null
      : (providers.find((item) => item.id === form.providerId) ?? linkedButInactive);

  /**
   * Advertencia de ADR-09.1: el usuario cambió un proveedor detectado sobre un
   * dominio obvio (gmail.com, outlook.com…). No bloquea — puede haber un caso
   * real — pero tiene que enterarse antes de guardar.
   */
  const strictMismatch =
    detected?.provider != null &&
    detected.provider.strict &&
    form.providerId !== detected.provider.id
      ? detected.provider
      : null;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Detección al salir del campo de correo. Nunca interrumpe el alta: si la
   * consulta falla, se sigue a mano sin mostrar error — el backend igual valida
   * la conexión al guardar.
   */
  async function handleEmailBlur() {
    const email = form.email.trim();
    if (!email.includes('@')) {
      return;
    }

    setDetecting(true);
    try {
      const response = await apiGet<{ data: ResolveProviderResult }>(
        `/mail-providers/resolve?email=${encodeURIComponent(email)}`,
      );
      setDetected(response.data);

      if (response.data.provider && !providerTouched) {
        update('providerId', response.data.provider.id);
      }
    } catch {
      setDetected(null);
    } finally {
      setDetecting(false);
    }
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

    const usesCustomServer = form.providerId === CUSTOM_PROVIDER;
    const portNumber = Number(form.imapPort);

    if (usesCustomServer) {
      if (form.imapHost.trim() === '') {
        toast.error('Indicá el servidor IMAP o elegí un servicio de correo de la lista.');
        return;
      }
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        toast.error('El puerto IMAP debe ser un entero entre 1 y 65535.');
        return;
      }
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

        // null desvincula (pasa a servidor personalizado); un id vincula.
        const nextProviderId = usesCustomServer ? null : form.providerId;
        if (nextProviderId !== account.providerId) {
          payload.providerId = nextProviderId;
        }

        // Host/puerto/TLS solo viajan en el camino personalizado: con perfil, el
        // backend los ignora y mandarlos solo ensucia el diff.
        if (usesCustomServer) {
          if (form.imapHost !== account.imapHost) payload.imapHost = form.imapHost;
          if (portNumber !== account.imapPort) payload.imapPort = portNumber;
          if (form.imapSecure !== account.imapSecure) payload.imapSecure = form.imapSecure;
        }

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
          ...(usesCustomServer
            ? {
                imapHost: form.imapHost,
                imapPort: portNumber,
                imapSecure: form.imapSecure,
              }
            : { providerId: form.providerId }),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
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
                onBlur={() => void handleEmailBlur()}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="providerId">Servicio de correo</Label>
            <Select
              value={form.providerId}
              onValueChange={(value) => {
                setProviderTouched(true);
                update('providerId', value);
              }}
            >
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Elegí un servicio" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
                {linkedButInactive && (
                  <SelectItem value={linkedButInactive.id}>
                    {linkedButInactive.name} (deshabilitado)
                  </SelectItem>
                )}
                <SelectItem value={CUSTOM_PROVIDER}>Servidor personalizado (avanzado)</SelectItem>
              </SelectContent>
            </Select>

            {detecting && (
              <p className="text-xs text-muted-foreground">Detectando el servicio de correo…</p>
            )}
            {!detecting && detected?.provider && form.providerId === detected.provider.id && (
              <p className="text-xs text-muted-foreground">
                Detectado automáticamente
                {detected.source === 'MX'
                  ? ' por el registro MX del dominio.'
                  : ' por el dominio del correo.'}
              </p>
            )}
            {!detecting && detected !== null && detected.provider === null && (
              <p className="text-xs text-muted-foreground">
                No se pudo identificar el servicio: elegilo de la lista o cargá el servidor a mano.
              </p>
            )}
            {linkedButInactive && (
              <p className="text-xs text-muted-foreground">
                Este servicio fue deshabilitado por el administrador. La cuenta sigue sincronizando,
                pero conviene migrarla a otro servicio.
              </p>
            )}
          </div>

          {strictMismatch && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              El dominio de <strong>{form.email}</strong> corresponde a{' '}
              <strong>{strictMismatch.name}</strong>. Si elegís otro servicio, es muy probable que
              la descarga de correos falle.
            </div>
          )}

          {selectedProvider ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
              <p className="font-mono text-xs">
                {selectedProvider.imapHost}:{selectedProvider.imapPort}
                {selectedProvider.imapSecure ? ' · TLS/SSL' : ' · sin TLS'}
              </p>
              <p className="text-xs text-muted-foreground">
                El servidor y el puerto los administra el proveedor del sistema. Si cambian, tu
                cuenta los toma en la siguiente sincronización sin que hagas nada.
              </p>
              {selectedProvider.notes && (
                <p className="text-xs text-muted-foreground">{selectedProvider.notes}</p>
              )}
              {selectedProvider.helpUrl && (
                <a
                  className="text-xs underline underline-offset-4"
                  href={selectedProvider.helpUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Cómo obtener la contraseña para este servicio
                </a>
              )}
            </div>
          ) : (
            <>
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
            </>
          )}

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
