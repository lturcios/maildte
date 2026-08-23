import { useEffect, useState } from 'react';
import { AlertTriangleIcon, DatabaseIcon, FilesIcon, MailIcon, UsersIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { useAccounts } from '@/hooks/useAccounts';
import type { StatsSummary } from '@/types/domain';
import { EmailsByMonthChart } from '@/components/dashboard/EmailsByMonthChart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface StatsSummaryResponse {
  data: StatsSummary;
}

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | null;
}

function StatCard({ icon: Icon, label, value }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          {value === null ? (
            <Skeleton className="h-6 w-16" />
          ) : (
            <span className="text-xl font-semibold">{value}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { accounts, getAlias, loading: accountsLoading } = useAccounts();
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const response = await apiGet<StatsSummaryResponse>('/stats/summary');
        if (!cancelled) {
          setSummary(response.data);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof ApiError ? error.message : 'No se pudo cargar el resumen operativo.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = summary
    ? summary.byAccount.reduce(
        (acc, item) => ({
          totalEmails: acc.totalEmails + item.totalEmails,
          filesCount: acc.filesCount + item.filesCount,
          totalBytes: acc.totalBytes + item.totalBytes,
        }),
        { totalEmails: 0, filesCount: 0, totalBytes: 0 },
      )
    : null;

  const activeAccountsCount = accounts.filter((account) => account.status === 'ACTIVA').length;
  const isLoading = loading || accountsLoading;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Resumen operativo de sincronización de todas las cuentas del tenant.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={MailIcon}
          label="Correos totales"
          value={isLoading ? null : String(totals?.totalEmails ?? 0)}
        />
        <StatCard
          icon={FilesIcon}
          label="Archivos totales"
          value={isLoading ? null : String(totals?.filesCount ?? 0)}
        />
        <StatCard
          icon={DatabaseIcon}
          label="Espacio usado"
          value={isLoading ? null : formatBytes(totals?.totalBytes ?? 0)}
        />
        <StatCard
          icon={UsersIcon}
          label="Cuentas activas"
          value={isLoading ? null : String(activeAccountsCount)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Correos por mes</CardTitle>
          <CardDescription>Últimos 12 meses, todas las cuentas.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <EmailsByMonthChart byAccountMonth={summary?.byAccountMonth ?? []} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Últimos errores</CardTitle>
          <CardDescription>Los últimos syncs que terminaron en ERROR.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : summary && summary.recentErrors.length > 0 ? (
            summary.recentErrors.map((log) => (
              <div
                key={log.id}
                className="flex flex-col gap-1 rounded-md border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <AlertTriangleIcon className="size-4 text-destructive" aria-hidden="true" />
                    {getAlias(log.accountId)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(log.startedAt)}
                  </span>
                </div>
                {log.errorDetail && (
                  <p className="text-sm text-muted-foreground">{log.errorDetail}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No hay errores recientes.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
