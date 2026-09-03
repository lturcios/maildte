import { useEffect, useState } from 'react';
import { BanIcon, GaugeIcon, PencilIcon, PlayIcon, PlusIcon, UserPlusIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiPost, ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useTenantsStore } from '@/stores/tenants-store';
import type { AdminTenant } from '@/types/domain';
import { CreateTenantAdminDialog } from '@/components/tenants/CreateTenantAdminDialog';
import { TenantFormDialog } from '@/components/tenants/TenantFormDialog';
import { TenantUsageDialog } from '@/components/tenants/TenantUsageDialog';
import { TenantStatusBadge } from '@/components/common/StatusBadges';
import {
  RecordCard,
  RecordCardActions,
  RecordCardEmpty,
  RecordCardField,
  RecordCardFields,
  RecordCardHeader,
  RecordCardList,
  RecordCardSkeletons,
} from '@/components/common/RecordCard';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Alta y administración de tenants (organizaciones cliente), exclusiva de
 * SUPERADMIN. Sigue el mismo patrón lista+dialogs que CuentasPage; a
 * diferencia de esa página, acá no hay un hook useTenants() dedicado (ver
 * comentario en src/stores/tenants-store.ts) porque solo esta vista
 * consume la store.
 */
export function OrganizacionesPage() {
  const tenants = useTenantsStore((state) => state.tenants);
  const loading = useTenantsStore((state) => state.loading);
  const loaded = useTenantsStore((state) => state.loaded);
  const error = useTenantsStore((state) => state.error);
  const fetchTenants = useTenantsStore((state) => state.fetchTenants);
  const addTenant = useTenantsStore((state) => state.addTenant);
  const updateTenant = useTenantsStore((state) => state.updateTenant);

  useEffect(() => {
    if (!loaded) {
      void fetchTenants();
    }
  }, [loaded, fetchTenants]);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<AdminTenant | null>(null);
  const [creatingAdminFor, setCreatingAdminFor] = useState<AdminTenant | null>(null);
  const [viewingUsageFor, setViewingUsageFor] = useState<AdminTenant | null>(null);
  const [suspendingTenant, setSuspendingTenant] = useState<AdminTenant | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  function openCreateDialog() {
    setEditingTenant(null);
    setFormOpen(true);
  }

  function openEditDialog(tenant: AdminTenant) {
    setEditingTenant(tenant);
    setFormOpen(true);
  }

  function handleSaved(tenant: AdminTenant) {
    if (editingTenant) {
      updateTenant(tenant);
    } else {
      addTenant(tenant);
    }
  }

  async function handleConfirmSuspend() {
    if (!suspendingTenant) {
      return;
    }
    setSuspending(true);
    try {
      const response = await apiPost<{ data: AdminTenant }>(
        `/admin/tenants/${suspendingTenant.id}/suspend`,
      );
      updateTenant(response.data);
      toast.success(`Tenant "${suspendingTenant.name}" suspendido.`);
      setSuspendingTenant(null);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo suspender el tenant.');
    } finally {
      setSuspending(false);
    }
  }

  async function handleActivate(tenant: AdminTenant) {
    setActivatingId(tenant.id);
    try {
      const response = await apiPost<{ data: AdminTenant }>(`/admin/tenants/${tenant.id}/activate`);
      updateTenant(response.data);
      toast.success(`Tenant "${tenant.name}" activado.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo activar el tenant.');
    } finally {
      setActivatingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Organizaciones</h1>
          <p className="text-sm text-muted-foreground">
            Alta y administración de tenants (organizaciones cliente) y sus admins.
          </p>
        </div>
        <Button type="button" className="w-full sm:w-auto" onClick={openCreateDialog}>
          <PlusIcon className="size-4" aria-hidden="true" />
          Nuevo tenant
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Mobile: card por tenant. Las cuotas (máx. cuentas / almacenamiento) se
          agrupan en dos columnas y las cinco acciones bajan al pie con etiqueta. */}
      <div className="md:hidden">
        {loading ? (
          <RecordCardSkeletons count={3} />
        ) : tenants.length === 0 ? (
          <RecordCardEmpty>Todavía no hay tenants registrados.</RecordCardEmpty>
        ) : (
          <RecordCardList>
            {tenants.map((tenant) => (
              <RecordCard key={tenant.id}>
                <RecordCardHeader
                  title={tenant.name}
                  subtitle={tenant.slug}
                  aside={<TenantStatusBadge status={tenant.status} />}
                />

                <RecordCardFields columns={2}>
                  <RecordCardField label="Máx. cuentas">{tenant.maxAccounts}</RecordCardField>
                  <RecordCardField label="Máx. almacenamiento">
                    {formatBytes(Number(tenant.maxStorageBytes))}
                  </RecordCardField>
                  <RecordCardField label="Creado">
                    {formatDateTime(tenant.createdAt)}
                  </RecordCardField>
                </RecordCardFields>

                <RecordCardActions>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setViewingUsageFor(tenant)}
                  >
                    <GaugeIcon className="size-4" aria-hidden="true" />
                    Uso
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCreatingAdminFor(tenant)}
                  >
                    <UserPlusIcon className="size-4" aria-hidden="true" />
                    Admin
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openEditDialog(tenant)}
                  >
                    <PencilIcon className="size-4" aria-hidden="true" />
                    Editar
                  </Button>
                  {tenant.status === 'ACTIVO' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSuspendingTenant(tenant)}
                    >
                      <BanIcon className="size-4 text-destructive" aria-hidden="true" />
                      Suspender
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={activatingId === tenant.id}
                      onClick={() => void handleActivate(tenant)}
                    >
                      <PlayIcon className="size-4 text-chart-4" aria-hidden="true" />
                      Activar
                    </Button>
                  )}
                </RecordCardActions>
              </RecordCard>
            ))}
          </RecordCardList>
        )}
      </div>

      <div className="hidden rounded-md border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Máx. cuentas</TableHead>
              <TableHead className="text-right">Máx. almacenamiento</TableHead>
              <TableHead>Creado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : tenants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                  Todavía no hay tenants registrados.
                </TableCell>
              </TableRow>
            ) : (
              tenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell className="font-medium">{tenant.name}</TableCell>
                  <TableCell className="text-muted-foreground">{tenant.slug}</TableCell>
                  <TableCell>
                    <TenantStatusBadge status={tenant.status} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {tenant.maxAccounts}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatBytes(Number(tenant.maxStorageBytes))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(tenant.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Ver uso"
                        onClick={() => setViewingUsageFor(tenant)}
                      >
                        <GaugeIcon className="size-4" aria-hidden="true" />
                        <span className="sr-only">Ver uso</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Agregar admin"
                        onClick={() => setCreatingAdminFor(tenant)}
                      >
                        <UserPlusIcon className="size-4" aria-hidden="true" />
                        <span className="sr-only">Agregar admin</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Editar"
                        onClick={() => openEditDialog(tenant)}
                      >
                        <PencilIcon className="size-4" aria-hidden="true" />
                        <span className="sr-only">Editar</span>
                      </Button>
                      {tenant.status === 'ACTIVO' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Suspender"
                          onClick={() => setSuspendingTenant(tenant)}
                        >
                          <BanIcon className="size-4 text-destructive" aria-hidden="true" />
                          <span className="sr-only">Suspender</span>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Activar"
                          disabled={activatingId === tenant.id}
                          onClick={() => void handleActivate(tenant)}
                        >
                          <PlayIcon className="size-4 text-chart-4" aria-hidden="true" />
                          <span className="sr-only">Activar</span>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TenantFormDialog
        tenant={editingTenant}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={handleSaved}
      />

      <CreateTenantAdminDialog
        tenant={creatingAdminFor}
        onOpenChange={(open) => {
          if (!open) {
            setCreatingAdminFor(null);
          }
        }}
      />

      <TenantUsageDialog
        tenant={viewingUsageFor}
        onOpenChange={(open) => {
          if (!open) {
            setViewingUsageFor(null);
          }
        }}
      />

      <AlertDialog
        open={suspendingTenant !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSuspendingTenant(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Suspender "{suspendingTenant?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Se detiene la sincronización de todas las cuentas del tenant. Los correos y adjuntos
              ya archivados se conservan, y podés reactivarlo cuando quieras.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={suspending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={suspending} onClick={() => void handleConfirmSuspend()}>
              {suspending ? 'Suspendiendo…' : 'Suspender'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
