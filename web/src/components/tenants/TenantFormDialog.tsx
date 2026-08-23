import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { apiPatch, apiPost, ApiError } from '@/lib/api-client';
import type { AdminTenant, CreateTenantInput, UpdateTenantInput } from '@/types/domain';
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

interface TenantFormDialogProps {
  /** null = alta de tenant nuevo; un AdminTenant = edición. */
  tenant: AdminTenant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (tenant: AdminTenant) => void;
}

interface FormState {
  name: string;
  slug: string;
  /** Vacío = no se envía y el backend aplica su default (3 cuentas). */
  maxAccounts: string;
  /** En GB para que sea legible; se convierte a bytes al enviar. Vacío = default backend (5 GB). */
  maxStorageGb: string;
}

const BYTES_PER_GB = 1024 ** 3;

function emptyForm(): FormState {
  return { name: '', slug: '', maxAccounts: '', maxStorageGb: '' };
}

/** Convierte el string de bytes (BigInt serializado) a un valor de GB legible para el input. */
function bytesToGbInput(maxStorageBytes: string): string {
  const gb = Number(maxStorageBytes) / BYTES_PER_GB;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(2);
}

function formFromTenant(tenant: AdminTenant): FormState {
  return {
    name: tenant.name,
    slug: tenant.slug,
    maxAccounts: String(tenant.maxAccounts),
    maxStorageGb: bytesToGbInput(tenant.maxStorageBytes),
  };
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Alta y edición de tenants en un único diálogo, mismo patrón que
 * AccountFormDialog. El `slug` es inmutable tras la creación (las rutas de
 * storage del tenant dependen de él): en edición se muestra como texto
 * fijo, no como input.
 *
 * `maxStorageBytes` se expone en GB (mucho más legible que el valor en
 * bytes que espera la API) y se convierte antes de armar el payload.
 */
export function TenantFormDialog({ tenant, open, onOpenChange, onSaved }: TenantFormDialogProps) {
  const isEditMode = tenant !== null;
  const [form, setForm] = useState<FormState>(() =>
    tenant ? formFromTenant(tenant) : emptyForm(),
  );
  const [submitting, setSubmitting] = useState(false);

  // Reinicia el formulario cada vez que el diálogo pasa de cerrado a
  // abierto (mismo patrón "adjusting state when a prop changes" que
  // AccountFormDialog, en vez de un efecto separado).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(tenant ? formFromTenant(tenant) : emptyForm());
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isEditMode) {
      const trimmedSlug = form.slug.trim();
      if (!SLUG_PATTERN.test(trimmedSlug)) {
        toast.error('El slug solo puede contener minúsculas, números y guiones.');
        return;
      }
    }

    const trimmedMaxAccounts = form.maxAccounts.trim();
    const maxAccountsNumber = trimmedMaxAccounts === '' ? undefined : Number(trimmedMaxAccounts);
    if (
      maxAccountsNumber !== undefined &&
      (!Number.isInteger(maxAccountsNumber) || maxAccountsNumber < 1 || maxAccountsNumber > 1000)
    ) {
      toast.error('El máximo de cuentas debe ser un entero entre 1 y 1000.');
      return;
    }

    const trimmedMaxStorageGb = form.maxStorageGb.trim();
    const maxStorageGbNumber = trimmedMaxStorageGb === '' ? undefined : Number(trimmedMaxStorageGb);
    if (
      maxStorageGbNumber !== undefined &&
      (!Number.isFinite(maxStorageGbNumber) || maxStorageGbNumber <= 0)
    ) {
      toast.error('El espacio máximo debe ser un número mayor a 0 (en GB).');
      return;
    }
    const maxStorageBytesNumber =
      maxStorageGbNumber !== undefined ? Math.round(maxStorageGbNumber * BYTES_PER_GB) : undefined;

    setSubmitting(true);
    try {
      if (isEditMode && tenant) {
        const payload: UpdateTenantInput = {};
        if (form.name !== tenant.name) payload.name = form.name;
        if (maxAccountsNumber !== undefined && maxAccountsNumber !== tenant.maxAccounts) {
          payload.maxAccounts = maxAccountsNumber;
        }
        if (
          maxStorageBytesNumber !== undefined &&
          maxStorageBytesNumber !== Number(tenant.maxStorageBytes)
        ) {
          payload.maxStorageBytes = maxStorageBytesNumber;
        }

        if (Object.keys(payload).length === 0) {
          onOpenChange(false);
          return;
        }

        const response = await apiPatch<{ data: AdminTenant }>(
          `/admin/tenants/${tenant.id}`,
          payload,
        );
        onSaved(response.data);
        toast.success('Tenant actualizado.');
        onOpenChange(false);
      } else {
        const payload: CreateTenantInput = {
          name: form.name,
          slug: form.slug.trim(),
          ...(maxAccountsNumber !== undefined ? { maxAccounts: maxAccountsNumber } : {}),
          ...(maxStorageBytesNumber !== undefined
            ? { maxStorageBytes: maxStorageBytesNumber }
            : {}),
        };
        const response = await apiPost<{ data: AdminTenant }>('/admin/tenants', payload);
        onSaved(response.data);
        toast.success('Tenant creado.');
        onOpenChange(false);
      }
    } catch (error) {
      // El diálogo queda abierto a propósito para que el usuario pueda corregir y reintentar.
      toast.error(error instanceof ApiError ? error.message : 'No se pudo guardar el tenant.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Editar tenant' : 'Nuevo tenant'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'El slug no puede modificarse: las rutas de almacenamiento del tenant dependen de él.'
              : 'El slug queda fijo para siempre una vez creado el tenant: elegilo con cuidado.'}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              required
              maxLength={120}
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="slug">Slug</Label>
            {isEditMode ? (
              <Input id="slug" value={form.slug} disabled readOnly />
            ) : (
              <Input
                id="slug"
                required
                maxLength={60}
                pattern="[a-z0-9-]+"
                placeholder="empresa-cliente"
                value={form.slug}
                onChange={(event) => update('slug', event.target.value)}
              />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="maxAccounts">Máximo de cuentas IMAP</Label>
              <Input
                id="maxAccounts"
                type="number"
                min={1}
                max={1000}
                placeholder="3 (por defecto)"
                value={form.maxAccounts}
                onChange={(event) => update('maxAccounts', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="maxStorageGb">Espacio máximo (GB)</Label>
              <Input
                id="maxStorageGb"
                type="number"
                min={0}
                step="any"
                placeholder="5 (por defecto)"
                value={form.maxStorageGb}
                onChange={(event) => update('maxStorageGb', event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
