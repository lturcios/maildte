import { type FormEvent, useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { apiPatch, apiPost, ApiError } from '@/lib/api-client';
import type {
  CreateMailProviderInput,
  DomainMatchKind,
  MailProvider,
  MailProviderDomainInput,
  MailProviderUsage,
  UpdateMailProviderInput,
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
import { Textarea } from '@/components/ui/textarea';

interface MailProviderFormDialogProps {
  /** null = alta de perfil nuevo; un MailProvider = edición. */
  provider: MailProvider | null;
  /** Uso conocido del perfil, para el diálogo de confirmación del endpoint. */
  usage: MailProviderUsage | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (provider: MailProvider) => void;
}

interface FormState {
  key: string;
  name: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  defaultMailbox: string;
  strict: boolean;
  active: boolean;
  sortOrder: string;
  notes: string;
  helpUrl: string;
  domains: MailProviderDomainInput[];
}

function emptyForm(): FormState {
  return {
    key: '',
    name: '',
    imapHost: '',
    imapPort: '993',
    imapSecure: true,
    defaultMailbox: 'INBOX',
    strict: false,
    active: true,
    sortOrder: '100',
    notes: '',
    helpUrl: '',
    domains: [],
  };
}

function formFromProvider(provider: MailProvider): FormState {
  return {
    key: provider.key,
    name: provider.name,
    imapHost: provider.imapHost,
    imapPort: String(provider.imapPort),
    imapSecure: provider.imapSecure,
    defaultMailbox: provider.defaultMailbox,
    strict: provider.strict,
    active: provider.active,
    sortOrder: String(provider.sortOrder),
    notes: provider.notes ?? '',
    helpUrl: provider.helpUrl ?? '',
    domains: provider.domains.map((entry) => ({ domain: entry.domain, kind: entry.kind })),
  };
}

/**
 * Alta y edición de perfiles del catálogo de servicios de correo (Addendum 09),
 * exclusiva de SUPERADMIN.
 *
 * Lo que distingue este formulario del resto del panel: cambiar host, puerto o
 * TLS de un perfil que ya usan cuentas NO es una edición cualquiera. Por la
 * referencia viva de ADR-09.1, esos valores los toman todas las cuentas
 * vinculadas —de todos los tenants— en su próxima sincronización. Por eso el
 * formulario exige escribir el número exacto de cuentas afectadas antes de
 * habilitar el guardado, y el backend vuelve a validarlo por su cuenta.
 */
export function MailProviderFormDialog({
  provider,
  usage,
  open,
  onOpenChange,
  onSaved,
}: MailProviderFormDialogProps) {
  const isEditMode = provider !== null;
  const [form, setForm] = useState<FormState>(() =>
    provider ? formFromProvider(provider) : emptyForm(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(provider ? formFromProvider(provider) : emptyForm());
      setConfirmText('');
    }
  }

  const portNumber = Number(form.imapPort);

  /** ¿Este guardado cambia el endpoint que usan las cuentas vinculadas? */
  const endpointChanged =
    isEditMode &&
    (form.imapHost !== provider.imapHost ||
      portNumber !== provider.imapPort ||
      form.imapSecure !== provider.imapSecure);

  const affectedAccounts = usage?.accounts ?? 0;
  const needsConfirmation = endpointChanged && affectedAccounts > 0;
  const confirmationOk = !needsConfirmation || Number(confirmText) === affectedAccounts;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateDomain(index: number, patch: Partial<MailProviderDomainInput>) {
    setForm((prev) => ({
      ...prev,
      domains: prev.domains.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    }));
  }

  function addDomain() {
    setForm((prev) => ({ ...prev, domains: [...prev.domains, { domain: '', kind: 'DOMAIN' }] }));
  }

  function removeDomain(index: number) {
    setForm((prev) => ({ ...prev, domains: prev.domains.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      toast.error('El puerto IMAP debe ser un entero entre 1 y 65535.');
      return;
    }
    const sortOrderNumber = Number(form.sortOrder);
    if (!Number.isInteger(sortOrderNumber) || sortOrderNumber < 0) {
      toast.error('El orden debe ser un entero mayor o igual a 0.');
      return;
    }

    // Se descartan las filas vacías del editor en vez de rebotar el guardado:
    // agregar una fila y no completarla es un accidente común, no un error.
    const domains = form.domains
      .map((entry) => ({ domain: entry.domain.trim().toLowerCase(), kind: entry.kind }))
      .filter((entry) => entry.domain !== '');

    const duplicated = domains.find(
      (entry, index) =>
        domains.findIndex((other) => other.domain === entry.domain && other.kind === entry.kind) !==
        index,
    );
    if (duplicated) {
      toast.error(`El dominio "${duplicated.domain}" está repetido en la lista.`);
      return;
    }

    setSubmitting(true);
    try {
      if (isEditMode) {
        const payload: UpdateMailProviderInput = {
          name: form.name,
          imapHost: form.imapHost,
          imapPort: portNumber,
          imapSecure: form.imapSecure,
          defaultMailbox: form.defaultMailbox,
          strict: form.strict,
          active: form.active,
          sortOrder: sortOrderNumber,
          notes: form.notes.trim(),
          domains,
          ...(form.helpUrl.trim() !== '' ? { helpUrl: form.helpUrl.trim() } : {}),
          ...(needsConfirmation ? { confirmAffectedAccounts: affectedAccounts } : {}),
        };
        const response = await apiPatch<{ data: MailProvider }>(
          `/admin/mail-providers/${provider.id}`,
          payload,
        );
        onSaved(response.data);
        toast.success('Servicio de correo actualizado.');
      } else {
        const payload: CreateMailProviderInput = {
          key: form.key.trim(),
          name: form.name,
          imapHost: form.imapHost,
          imapPort: portNumber,
          imapSecure: form.imapSecure,
          defaultMailbox: form.defaultMailbox,
          strict: form.strict,
          active: form.active,
          sortOrder: sortOrderNumber,
          domains,
          ...(form.notes.trim() !== '' ? { notes: form.notes.trim() } : {}),
          ...(form.helpUrl.trim() !== '' ? { helpUrl: form.helpUrl.trim() } : {}),
        };
        const response = await apiPost<{ data: MailProvider }>('/admin/mail-providers', payload);
        onSaved(response.data);
        toast.success('Servicio de correo creado.');
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo guardar el servicio de correo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? `Editar "${provider.name}"` : 'Nuevo servicio de correo'}
          </DialogTitle>
          <DialogDescription>
            Los parámetros de conexión de este perfil los usan en vivo todas las cuentas vinculadas,
            de todas las organizaciones.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="key">Clave</Label>
              <Input
                id="key"
                required
                maxLength={60}
                pattern="[a-z0-9-]+"
                placeholder="gmail"
                disabled={isEditMode}
                value={form.key}
                onChange={(event) => update('key', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {isEditMode
                  ? 'La clave no se puede cambiar: el script de semilla la usa para identificar el perfil.'
                  : 'Solo minúsculas, números y guiones. No se puede cambiar después.'}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Nombre visible</Label>
              <Input
                id="name"
                required
                maxLength={120}
                placeholder="Gmail / Google Workspace"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
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
                placeholder="imap.gmail.com"
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

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={form.imapSecure}
                onChange={(event) => update('imapSecure', event.target.checked)}
              />
              Usar TLS/SSL (IMAPS)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={form.strict}
                onChange={(event) => update('strict', event.target.checked)}
              />
              Dominio obvio (advertir si el cliente lo cambia)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={form.active}
                onChange={(event) => update('active', event.target.checked)}
              />
              Habilitado en el alta de cuentas
            </label>
          </div>

          {!form.active && (
            <p className="text-xs text-muted-foreground">
              Deshabilitarlo lo saca del desplegable de alta, pero NO desvincula las cuentas que ya
              lo usan: siguen sincronizando con estos parámetros.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="defaultMailbox">Buzón por defecto</Label>
              <Input
                id="defaultMailbox"
                maxLength={255}
                placeholder="INBOX"
                value={form.defaultMailbox}
                onChange={(event) => update('defaultMailbox', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sortOrder">Orden en la lista</Label>
              <Input
                id="sortOrder"
                type="number"
                min={0}
                value={form.sortOrder}
                onChange={(event) => update('sortOrder', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="notes">Requisitos de autenticación</Label>
            <Textarea
              id="notes"
              rows={3}
              maxLength={1000}
              placeholder="Ej.: si la cuenta tiene verificación en dos pasos, hay que generar una contraseña de aplicación."
              value={form.notes}
              onChange={(event) => update('notes', event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Se muestra al cliente al elegir este servicio. Es lo que evita la mayoría de los
              reclamos de &quot;no me conecta&quot;.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="helpUrl">Enlace de ayuda (https)</Label>
            <Input
              id="helpUrl"
              type="url"
              maxLength={500}
              placeholder="https://support.google.com/accounts/answer/185833"
              value={form.helpUrl}
              onChange={(event) => update('helpUrl', event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Dominios de detección</Label>
              <Button type="button" variant="outline" size="sm" onClick={addDomain}>
                Agregar dominio
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <strong>Dominio del correo</strong>: coincidencia exacta (gmail.com).{' '}
              <strong>Sufijo MX</strong>: detecta el servicio detrás de un dominio propio del
              cliente (google.com). No cargues acá los MX de filtros antispam como pphosted.com:
              indican por dónde entra el correo, no dónde se leen los buzones.
            </p>

            {form.domains.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Sin dominios: este servicio nunca se va a detectar solo, el cliente tendrá que
                elegirlo de la lista.
              </p>
            ) : (
              form.domains.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={`Dominio ${index + 1}`}
                    maxLength={255}
                    placeholder="gmail.com"
                    value={entry.domain}
                    onChange={(event) => updateDomain(index, { domain: event.target.value })}
                  />
                  <Select
                    value={entry.kind}
                    onValueChange={(value) =>
                      updateDomain(index, { kind: value as DomainMatchKind })
                    }
                  >
                    <SelectTrigger className="w-48 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DOMAIN">Dominio del correo</SelectItem>
                      <SelectItem value="MX_SUFFIX">Sufijo MX</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Quitar dominio"
                    onClick={() => removeDomain(index)}
                  >
                    <Trash2Icon className="size-4 text-destructive" aria-hidden="true" />
                    <span className="sr-only">Quitar dominio</span>
                  </Button>
                </div>
              ))
            )}
          </div>

          {needsConfirmation && (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-sm font-medium">Este cambio afecta a cuentas en producción</p>
              <p className="text-xs">
                {affectedAccounts} cuenta(s) de {usage?.tenants ?? 0} organización(es) van a usar el
                servidor nuevo en su próxima sincronización. Si los datos están mal, esas cuentas
                dejan de descargar correo.
              </p>
              <Label htmlFor="confirmAffected" className="text-xs">
                Escribí <strong>{affectedAccounts}</strong> para confirmar
              </Label>
              <Input
                id="confirmAffected"
                inputMode="numeric"
                className="w-32"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting || !confirmationOk}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
