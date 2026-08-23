import { useEffect, useRef, useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, ApiError } from '@/lib/api-client';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useAccounts } from '@/hooks/useAccounts';
import type { Paginated, SyncLog } from '@/types/domain';
import { SyncStatusBadge } from '@/components/common/StatusBadges';
import { Pagination } from '@/components/common/Pagination';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'Todos los estados' },
  { value: 'EJECUTANDO', label: 'Ejecutando' },
  { value: 'COMPLETADO', label: 'Completado' },
  { value: 'COMPLETADO_CON_ERRORES', label: 'Completado con errores' },
  { value: 'ERROR', label: 'Error' },
];

const LIMIT = 50;
const AUTO_REFRESH_MS = 30_000;

interface Filters {
  accountId: string;
  status: string;
}

const DEFAULT_FILTERS: Filters = { accountId: 'all', status: 'all' };

function buildQuery(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.accountId !== 'all') params.set('accountId', filters.accountId);
  if (filters.status !== 'all') params.set('status', filters.status);
  params.set('page', String(page));
  params.set('limit', String(LIMIT));
  return params.toString();
}

export function LogsPage() {
  const { accounts, getAlias } = useAccounts();

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);

  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [, forceTick] = useState(0);

  const latestRequestId = useRef(0);

  async function fetchLogs(currentFilters: Filters, currentPage: number) {
    const requestId = ++latestRequestId.current;
    setFetching(true);
    try {
      const query = buildQuery(currentFilters, currentPage);
      const response = await apiGet<Paginated<SyncLog>>(`/sync-logs?${query}`);
      if (requestId !== latestRequestId.current) return;
      setLogs(response.data);
      setMeta(response.meta);
      setLastUpdatedAt(new Date());
    } catch (error) {
      if (requestId !== latestRequestId.current) return;
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'No se pudieron cargar los logs de sincronización.',
      );
    } finally {
      if (requestId === latestRequestId.current) {
        setFetching(false);
        setLoading(false);
      }
    }
  }

  // Cambiar un filtro vuelve a página 1. Se ajusta durante el render
  // (patrón "adjusting state when a prop changes" de React) en vez de en un
  // efecto separado.
  const filtersSignature = `${filters.accountId}:${filters.status}`;
  const [lastFiltersSignature, setLastFiltersSignature] = useState(filtersSignature);
  if (filtersSignature !== lastFiltersSignature) {
    setLastFiltersSignature(filtersSignature);
    setPage(1);
  }

  // Fetch inicial y cada vez que cambian filtros/página (el usuario mantiene su página actual).
  useEffect(() => {
    async function run() {
      await fetchLogs(filters, page);
    }
    void run();
  }, [filters, page]);

  // Auto-refresh cada 30s: reconsulta la página/filtros actuales sin resetear la página.
  useEffect(() => {
    const interval = setInterval(() => {
      void fetchLogs(filters, page);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [filters, page]);

  // Tick de 1s solo para refrescar el texto "actualizado hace Xs" sin refetchear.
  useEffect(() => {
    const interval = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Registro auditable de corridas de sincronización, por cuenta.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCwIcon
            className={fetching ? 'size-3.5 animate-spin' : 'size-3.5'}
            aria-hidden="true"
          />
          {lastUpdatedAt ? `Actualizado ${formatRelativeTime(lastUpdatedAt)}` : 'Cargando…'}
        </div>
      </div>

      <div className="grid gap-4 rounded-md border border-border bg-card p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Cuenta</Label>
          <Select
            value={filters.accountId}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, accountId: value }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las cuentas</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.alias}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Estado</Label>
          <Select
            value={filters.status}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, status: value }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cuenta</TableHead>
              <TableHead>Iniciado</TableHead>
              <TableHead>Finalizado</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Encontrados</TableHead>
              <TableHead className="text-right">Procesados</TableHead>
              <TableHead className="text-right">Omitidos</TableHead>
              <TableHead className="text-right">Archivos</TableHead>
              <TableHead>Origen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                  No hay corridas de sincronización que coincidan con los filtros.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-medium">{getAlias(log.accountId)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(log.startedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(log.finishedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <SyncStatusBadge status={log.status} />
                      {log.errorDetail && (
                        <span
                          className="max-w-56 truncate text-xs text-destructive"
                          title={log.errorDetail}
                        >
                          {log.errorDetail}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {log.emailsFound}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {log.emailsProcessed}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {log.emailsSkipped}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {log.filesDownloaded}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {log.trigger === 'manual' ? 'Manual' : 'Programado'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={meta.page} limit={meta.limit} total={meta.total} onPageChange={setPage} />
    </div>
  );
}
