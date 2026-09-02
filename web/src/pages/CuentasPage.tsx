import { useState } from 'react';
import { CalendarClockIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { apiDelete, apiPost, ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { formatAccountEndpoint } from '@/lib/imap-endpoint';
import { useAccountsStore } from '@/stores/accounts-store';
import { useAccounts } from '@/hooks/useAccounts';
import type { SafeAccount, TriggerSyncResult } from '@/types/domain';
import { AccountFormDialog } from '@/components/accounts/AccountFormDialog';
import { ResyncDialog } from '@/components/accounts/ResyncDialog';
import { AccountStatusBadge } from '@/components/common/StatusBadges';
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

export function CuentasPage() {
  const { accounts, loading, error } = useAccounts();
  const addAccount = useAccountsStore((state) => state.addAccount);
  const updateAccount = useAccountsStore((state) => state.updateAccount);
  const removeAccount = useAccountsStore((state) => state.removeAccount);

  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<SafeAccount | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<SafeAccount | null>(null);
  const [resyncingAccount, setResyncingAccount] = useState<SafeAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  function openCreateDialog() {
    setEditingAccount(null);
    setFormOpen(true);
  }

  function openEditDialog(account: SafeAccount) {
    setEditingAccount(account);
    setFormOpen(true);
  }

  function handleSaved(account: SafeAccount) {
    if (editingAccount) {
      updateAccount(account);
    } else {
      addAccount(account);
    }
  }

  async function handleSyncNow(account: SafeAccount) {
    setSyncingId(account.id);
    try {
      const response = await apiPost<{ data: TriggerSyncResult }>(`/accounts/${account.id}/sync`);
      if (response.data.enqueued) {
        toast.success(`Sincronización de "${account.alias}" encolada.`);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo encolar la sincronización.',
      );
    } finally {
      setSyncingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingAccount) {
      return;
    }
    setDeleting(true);
    try {
      await apiDelete(`/accounts/${deletingAccount.id}`);
      removeAccount(deletingAccount.id);
      toast.success(`Cuenta "${deletingAccount.alias}" eliminada.`);
      setDeletingAccount(null);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo eliminar la cuenta.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Cuentas</h1>
          <p className="text-sm text-muted-foreground">
            Cuentas IMAP conectadas al pipeline de sincronización de DTE.
          </p>
        </div>
        <Button type="button" onClick={openCreateDialog}>
          <PlusIcon className="size-4" aria-hidden="true" />
          Nueva cuenta
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Alias</TableHead>
              <TableHead>Correo</TableHead>
              <TableHead>Servidor IMAP</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Última sincronización</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Todavía no hay cuentas registradas.
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="font-medium">{account.alias}</TableCell>
                  <TableCell className="text-muted-foreground">{account.email}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <span>{formatAccountEndpoint(account)}</span>
                    {account.provider && (
                      <span className="block text-xs">{account.provider.name}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge status={account.status} lastError={account.lastError} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {account.lastSyncAt ? formatRelativeTime(account.lastSyncAt) : 'Nunca'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={
                          account.status !== 'ACTIVA'
                            ? `La cuenta está ${account.status.toLowerCase()} y no puede sincronizarse manualmente`
                            : 'Sincronizar ahora'
                        }
                        disabled={account.status !== 'ACTIVA' || syncingId === account.id}
                        onClick={() => void handleSyncNow(account)}
                      >
                        <RefreshCwIcon
                          className={syncingId === account.id ? 'size-4 animate-spin' : 'size-4'}
                          aria-hidden="true"
                        />
                        <span className="sr-only">Sincronizar ahora</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={
                          account.status !== 'ACTIVA'
                            ? `La cuenta está ${account.status.toLowerCase()} y no puede re-sincronizarse`
                            : 'Re-sincronizar desde fecha'
                        }
                        disabled={account.status !== 'ACTIVA'}
                        onClick={() => setResyncingAccount(account)}
                      >
                        <CalendarClockIcon className="size-4" aria-hidden="true" />
                        <span className="sr-only">Re-sincronizar desde fecha</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Editar"
                        onClick={() => openEditDialog(account)}
                      >
                        <PencilIcon className="size-4" aria-hidden="true" />
                        <span className="sr-only">Editar</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Eliminar"
                        onClick={() => setDeletingAccount(account)}
                      >
                        <Trash2Icon className="size-4 text-destructive" aria-hidden="true" />
                        <span className="sr-only">Eliminar</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AccountFormDialog
        account={editingAccount}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={handleSaved}
      />

      <ResyncDialog
        account={resyncingAccount}
        onOpenChange={(open) => {
          if (!open) {
            setResyncingAccount(null);
          }
        }}
      />

      <AlertDialog
        open={deletingAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingAccount(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar "{deletingAccount?.alias}"?</AlertDialogTitle>
            <AlertDialogDescription>
              La cuenta se desactiva y deja de sincronizarse. Los correos y adjuntos ya archivados
              se conservan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={() => void handleConfirmDelete()}>
              {deleting ? 'Eliminando…' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
