import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { apiPost, ApiError } from '@/lib/api-client';
import type { AdminTenant, CreateTenantAdminInput, TenantAdminUser } from '@/types/domain';
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

interface CreateTenantAdminDialogProps {
  /** null cierra el diálogo (mismo patrón que el AlertDialog de borrado en CuentasPage). */
  tenant: AdminTenant | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (user: TenantAdminUser) => void;
}

interface FormState {
  email: string;
  name: string;
  password: string;
}

function emptyForm(): FormState {
  return { email: '', name: '', password: '' };
}

/**
 * Alta de un usuario ADMIN para un tenant existente (POST /admin/tenants/:id/users).
 *
 * El backend NO impide llamar este endpoint más de una vez para el mismo
 * tenant (solo falla si el email ya existe globalmente), así que esto es
 * una acción repetible: el diálogo se puede reabrir para el mismo tenant
 * tantas veces como haga falta, no un paso de "onboarding" que se deshabilita
 * después del primer uso.
 */
export function CreateTenantAdminDialog({
  tenant,
  onOpenChange,
  onCreated,
}: CreateTenantAdminDialogProps) {
  const open = tenant !== null;
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  // Reinicia el formulario cada vez que el diálogo pasa de cerrado a abierto,
  // incluso si se reabre para un tenant distinto (mismo patrón que AccountFormDialog).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(emptyForm());
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenant) {
      return;
    }

    if (form.password.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres.');
      return;
    }

    setSubmitting(true);
    try {
      const payload: CreateTenantAdminInput = {
        email: form.email,
        name: form.name,
        password: form.password,
      };
      const response = await apiPost<{ data: TenantAdminUser }>(
        `/admin/tenants/${tenant.id}/users`,
        payload,
      );
      toast.success(`Admin "${response.data.email}" creado para "${tenant.name}".`);
      onCreated?.(response.data);
      onOpenChange(false);
    } catch (error) {
      // El diálogo queda abierto a propósito para que el usuario pueda corregir y reintentar.
      toast.error(error instanceof ApiError ? error.message : 'No se pudo crear el usuario admin.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar admin{tenant ? ` a "${tenant.name}"` : ''}</DialogTitle>
          <DialogDescription>
            Da de alta un usuario con rol ADMIN para este tenant. Se puede repetir para agregar más
            de un admin.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-name">Nombre</Label>
            <Input
              id="admin-name"
              required
              maxLength={120}
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-email">Correo</Label>
            <Input
              id="admin-email"
              type="email"
              required
              value={form.email}
              onChange={(event) => update('email', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-password">Contraseña</Label>
            <Input
              id="admin-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(event) => update('password', event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creando…' : 'Crear admin'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
