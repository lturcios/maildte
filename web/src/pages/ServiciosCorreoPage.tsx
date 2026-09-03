import { useEffect, useState } from 'react';
import { PencilIcon, PlugZapIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { apiDelete, apiPost, ApiError } from '@/lib/api-client';
import { useAdminMailProvidersStore } from '@/stores/admin-mail-providers-store';
import { useMailProvidersStore } from '@/stores/mail-providers-store';
import type { MailProvider, MailProviderProbeResult } from '@/types/domain';
import { MailProviderFormDialog } from '@/components/mail-providers/MailProviderFormDialog';
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
import { Badge } from '@/components/ui/badge';
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
 * Catálogo maestro de servicios de correo (Addendum 09), exclusivo de
 * SUPERADMIN. Mismo patrón lista+dialogs que OrganizacionesPage.
 *
 * La tabla muestra el uso de cada perfil porque acá las acciones destructivas
 * no son locales: por la referencia viva de ADR-09.1, editar el endpoint de un
 * perfil cambia la conexión de todas las cuentas vinculadas, de todos los
 * tenants. Saber "esto lo usan 12 cuentas de 4 organizaciones" antes de tocar
 * nada es parte del diseño, no un adorno.
 */
export function ServiciosCorreoPage() {
  const providers = useAdminMailProvidersStore((state) => state.providers);
  const usage = useAdminMailProvidersStore((state) => state.usage);
  const loading = useAdminMailProvidersStore((state) => state.loading);
  const loaded = useAdminMailProvidersStore((state) => state.loaded);
  const error = useAdminMailProvidersStore((state) => state.error);
  const fetchProviders = useAdminMailProvidersStore((state) => state.fetchProviders);
  const fetchUsage = useAdminMailProvidersStore((state) => state.fetchUsage);
  const upsertProvider = useAdminMailProvidersStore((state) => state.upsertProvider);
  const removeProvider = useAdminMailProvidersStore((state) => state.removeProvider);

  // El catálogo público lo consume el alta de cuentas y está cacheado: hay que
  // invalidarlo cuando el SUPERADMIN toca un perfil, o el desplegable de
  // Cuentas seguiría mostrando datos viejos en la misma sesión.
  const refreshPublicCatalog = useMailProvidersStore((state) => state.fetchProviders);

  useEffect(() => {
    if (!loaded) {
      void fetchProviders();
    }
    void fetchUsage();
  }, [loaded, fetchProviders, fetchUsage]);

  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<MailProvider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<MailProvider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);

  function openCreateDialog() {
    setEditingProvider(null);
    setFormOpen(true);
  }

  function openEditDialog(provider: MailProvider) {
    setEditingProvider(provider);
    setFormOpen(true);
  }

  function handleSaved(provider: MailProvider) {
    upsertProvider(provider);
    void fetchUsage();
    void refreshPublicCatalog(true);
  }

  async function handleProbe(provider: MailProvider) {
    setProbingId(provider.id);
    try {
      const response = await apiPost<{ data: MailProviderProbeResult }>(
        `/admin/mail-providers/${provider.id}/probe`,
      );
      if (response.data.reachable) {
        toast.success(
          `${provider.imapHost}:${provider.imapPort} responde como servidor IMAP (${response.data.latencyMs} ms).`,
        );
      } else {
        toast.error(`No se pudo verificar el servidor: ${response.data.reason}`);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo probar el servidor.');
    } finally {
      setProbingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingProvider) {
      return;
    }
    setDeleting(true);
    try {
      await apiDelete(`/admin/mail-providers/${deletingProvider.id}`);
      removeProvider(deletingProvider.id);
      void refreshPublicCatalog(true);
      toast.success(`Servicio "${deletingProvider.name}" eliminado.`);
      setDeletingProvider(null);
    } catch (error) {
      // El backend rebota con 409 si alguna cuenta lo usa (incluidas las
      // eliminadas por soft delete, que conservan el vínculo).
      toast.error(error instanceof ApiError ? error.message : 'No se pudo eliminar el servicio.');
    } finally {
      setDeleting(false);
    }
  }

  const deletingUsage = deletingProvider ? usage[deletingProvider.id] : undefined;
  const deletingInUse = (deletingUsage?.accounts ?? 0) > 0;

  function domainsSummary(provider: MailProvider): string {
    if (provider.domains.length === 0) {
      return 'Sin detección';
    }
    const domains = provider.domains.filter((d) => d.kind === 'DOMAIN').length;
    const mx = provider.domains.filter((d) => d.kind === 'MX_SUFFIX').length;
    return `${domains} dominio(s), ${mx} MX`;
  }

  function endpointOf(provider: MailProvider): string {
    return `${provider.imapHost}:${provider.imapPort}${provider.imapSecure ? '' : ' (sin TLS)'}`;
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Servicios de correo</h1>
          <p className="text-sm text-muted-foreground">
            Catálogo compartido por todas las organizaciones: evita que cada cliente tenga que
            escribir servidor, puerto y TLS al dar de alta una cuenta.
          </p>
        </div>
        <Button type="button" className="w-full sm:w-auto" onClick={openCreateDialog}>
          <PlusIcon className="size-4" aria-hidden="true" />
          Nuevo servicio
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Mobile: card por servicio. El uso (cuentas/organizaciones) sube a campo
          propio en vez de una celda comprimida: es el dato que decide si tocar
          el perfil es seguro (ADR-09.1, referencia viva). */}
      <div className="md:hidden">
        {loading ? (
          <RecordCardSkeletons count={4} />
        ) : providers.length === 0 ? (
          <RecordCardEmpty>Todavía no hay servicios de correo cargados.</RecordCardEmpty>
        ) : (
          <RecordCardList>
            {providers.map((provider) => {
              const providerUsage = usage[provider.id];
              const accounts = providerUsage?.accounts ?? 0;

              return (
                <RecordCard key={provider.id}>
                  <RecordCardHeader
                    title={provider.name}
                    subtitle={<span className="font-mono">{provider.key}</span>}
                    aside={
                      <Badge variant={provider.active ? 'default' : 'secondary'}>
                        {provider.active ? 'Habilitado' : 'Deshabilitado'}
                      </Badge>
                    }
                  />

                  {provider.strict && <Badge variant="outline">Dominio obvio</Badge>}

                  <RecordCardFields>
                    <RecordCardField label="Servidor">
                      <span className="font-mono text-xs">{endpointOf(provider)}</span>
                    </RecordCardField>
                    <RecordCardField label="Dominios">{domainsSummary(provider)}</RecordCardField>
                    <RecordCardField label="En uso">
                      {accounts === 0
                        ? 'Sin uso'
                        : `${accounts} cuenta(s) · ${providerUsage?.tenants ?? 0} organización(es)`}
                    </RecordCardField>
                  </RecordCardFields>

                  <RecordCardActions>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={probingId === provider.id}
                      onClick={() => void handleProbe(provider)}
                    >
                      <PlugZapIcon className="size-4" aria-hidden="true" />
                      Probar
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(provider)}
                    >
                      <PencilIcon className="size-4" aria-hidden="true" />
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title={
                        accounts > 0
                          ? `No se puede borrar: lo usan ${accounts} cuenta(s)`
                          : undefined
                      }
                      onClick={() => setDeletingProvider(provider)}
                    >
                      <Trash2Icon className="size-4 text-destructive" aria-hidden="true" />
                      Eliminar
                    </Button>
                  </RecordCardActions>
                </RecordCard>
              );
            })}
          </RecordCardList>
        )}
      </div>

      <div className="hidden rounded-md border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Servidor</TableHead>
              <TableHead>Dominios</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">En uso</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Todavía no hay servicios de correo cargados.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((provider) => {
                const providerUsage = usage[provider.id];
                const accounts = providerUsage?.accounts ?? 0;

                return (
                  <TableRow key={provider.id}>
                    <TableCell>
                      <span className="font-medium">{provider.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {provider.key}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {endpointOf(provider)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {domainsSummary(provider)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={provider.active ? 'default' : 'secondary'}>
                          {provider.active ? 'Habilitado' : 'Deshabilitado'}
                        </Badge>
                        {provider.strict && <Badge variant="outline">Dominio obvio</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {accounts === 0 ? (
                        <span className="text-xs">Sin uso</span>
                      ) : (
                        <span className="text-xs">
                          {accounts} cuenta(s)
                          <span className="block">
                            {providerUsage?.tenants ?? 0} organización(es)
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Probar servidor"
                          disabled={probingId === provider.id}
                          onClick={() => void handleProbe(provider)}
                        >
                          <PlugZapIcon className="size-4" aria-hidden="true" />
                          <span className="sr-only">Probar servidor</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Editar"
                          onClick={() => openEditDialog(provider)}
                        >
                          <PencilIcon className="size-4" aria-hidden="true" />
                          <span className="sr-only">Editar</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title={
                            accounts > 0
                              ? `No se puede borrar: lo usan ${accounts} cuenta(s)`
                              : 'Eliminar'
                          }
                          onClick={() => setDeletingProvider(provider)}
                        >
                          <Trash2Icon className="size-4 text-destructive" aria-hidden="true" />
                          <span className="sr-only">Eliminar</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <MailProviderFormDialog
        provider={editingProvider}
        usage={editingProvider ? usage[editingProvider.id] : undefined}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={handleSaved}
      />

      <AlertDialog
        open={deletingProvider !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingProvider(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar "{deletingProvider?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingInUse
                ? `No se va a poder: ${deletingUsage?.accounts ?? 0} cuenta(s) usan este servicio${
                    (deletingUsage?.deletedAccounts ?? 0) > 0
                      ? `, ${deletingUsage?.deletedAccounts} de ellas eliminadas (conservan el vínculo y también bloquean)`
                      : ''
                  }. Para sacarlo del alta de cuentas sin romper las existentes, editalo y desmarcá "Habilitado en el alta de cuentas".`
                : 'Ninguna cuenta lo usa, así que se puede eliminar. Los dominios de detección asociados se borran con él.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting || deletingInUse}
              onClick={() => void handleConfirmDelete()}
            >
              {deleting ? 'Eliminando…' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
