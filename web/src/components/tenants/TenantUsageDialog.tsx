import { useEffect, useState } from 'react';
import { AlertTriangleIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { AdminTenant, TenantUsage } from '@/types/domain';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface TenantUsageDialogProps {
  /** null cierra el diálogo (mismo patrón que CreateTenantAdminDialog). */
  tenant: AdminTenant | null;
  onOpenChange: (open: boolean) => void;
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}

/**
 * Vista de solo lectura de GET /admin/tenants/:id/usage. No resuelve
 * accountId -> alias (a diferencia de Dashboard/Logs, que usan
 * useAccounts()): esa store solo cachea las cuentas del tenant del usuario
 * logueado, y un SUPERADMIN puede inspeccionar cualquier tenant ajeno.
 */
export function TenantUsageDialog({ tenant, onOpenChange }: TenantUsageDialogProps) {
  const open = tenant !== null;
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenant) {
      return;
    }

    let cancelled = false;

    async function load(tenantId: string) {
      setLoading(true);
      setUsage(null);
      try {
        const response = await apiGet<{ data: TenantUsage }>(`/admin/tenants/${tenantId}/usage`);
        if (!cancelled) {
          setUsage(response.data);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof ApiError ? error.message : 'No se pudo cargar el uso del tenant.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load(tenant.id);
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  const totalEmails = usage?.emailsByStatus.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Uso{tenant ? ` de "${tenant.name}"` : ''}</DialogTitle>
          <DialogDescription>Consumo y actividad reciente del tenant.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : usage ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <StatBlock label="Cuentas" value={String(usage.accounts)} />
              <StatBlock label="Correos procesados" value={String(totalEmails)} />
              <StatBlock label="Archivos" value={String(usage.totalFiles)} />
              <StatBlock label="Espacio usado" value={formatBytes(usage.totalBytes)} />
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Correos por estado</h3>
              {usage.emailsByStatus.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todavía no hay correos procesados.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {usage.emailsByStatus.map((item) => (
                    <span
                      key={item.status}
                      className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {item.status}:{' '}
                      <span className="font-medium text-foreground">{item.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Errores recientes</h3>
              {usage.recentErrors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay errores recientes.</p>
              ) : (
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {usage.recentErrors.map((errorLog) => (
                    <div
                      key={errorLog.id}
                      className="flex flex-col gap-1 rounded-md border border-border bg-card p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="flex items-center gap-2 text-sm font-medium"
                          title={errorLog.accountId}
                        >
                          <AlertTriangleIcon
                            className="size-4 text-destructive"
                            aria-hidden="true"
                          />
                          <span className="max-w-48 truncate font-mono text-xs">
                            {errorLog.accountId}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(errorLog.startedAt)}
                        </span>
                      </div>
                      {errorLog.errorDetail && (
                        <p className="text-sm text-muted-foreground">{errorLog.errorDetail}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
