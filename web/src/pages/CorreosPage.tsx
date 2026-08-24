import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiDownload, apiGet, ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useAccounts } from '@/hooks/useAccounts';
import type { Attachment, Paginated, ProcessedEmailWithAttachments } from '@/types/domain';
import { EmailStatusBadge } from '@/components/common/StatusBadges';
import { Pagination } from '@/components/common/Pagination';
import { ExportZipPanel } from '@/components/emails/ExportZipPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  { value: 'PROCESADO', label: 'Procesado' },
  { value: 'SIN_ADJUNTOS', label: 'Sin adjuntos' },
  { value: 'ERROR', label: 'Error' },
];

const HAS_ATTACHMENTS_OPTIONS = [
  { value: 'all', label: 'Con y sin adjuntos' },
  { value: 'yes', label: 'Solo con adjuntos' },
  { value: 'no', label: 'Solo sin adjuntos' },
];

const LIMIT = 50;

interface Filters {
  accountId: string;
  from: string;
  to: string;
  status: string;
  hasAttachments: string;
}

const DEFAULT_FILTERS: Filters = {
  accountId: 'all',
  from: '',
  to: '',
  status: 'all',
  hasAttachments: 'all',
};

function buildQuery(filters: Filters, sender: string, page: number): string {
  const params = new URLSearchParams();
  if (filters.accountId !== 'all') params.set('accountId', filters.accountId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (sender.trim()) params.set('sender', sender.trim());
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.hasAttachments !== 'all') {
    params.set('hasAttachments', filters.hasAttachments === 'yes' ? 'true' : 'false');
  }
  params.set('page', String(page));
  params.set('limit', String(LIMIT));
  return params.toString();
}

export function CorreosPage() {
  const { accounts, getAlias } = useAccounts();

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [senderInput, setSenderInput] = useState('');
  const [debouncedSender, setDebouncedSender] = useState('');
  const [page, setPage] = useState(1);

  const [emails, setEmails] = useState<ProcessedEmailWithAttachments[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const latestRequestId = useRef(0);

  // Debounce del filtro de texto "remitente" (300-400ms).
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSender(senderInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [senderInput]);

  // Cualquier cambio de filtro real vuelve a página 1. Se ajusta durante el
  // render (patrón "adjusting state when a prop changes" de React) en vez de
  // en un efecto separado, para no encadenar un setState extra tras el commit.
  const filtersSignature = JSON.stringify([
    filters.accountId,
    filters.from,
    filters.to,
    filters.status,
    filters.hasAttachments,
    debouncedSender,
  ]);
  const [lastFiltersSignature, setLastFiltersSignature] = useState(filtersSignature);
  if (filtersSignature !== lastFiltersSignature) {
    setLastFiltersSignature(filtersSignature);
    setPage(1);
  }

  useEffect(() => {
    const requestId = ++latestRequestId.current;
    const query = buildQuery(filters, debouncedSender, page);

    async function run() {
      setLoading(true);
      try {
        const response = await apiGet<Paginated<ProcessedEmailWithAttachments>>(`/emails?${query}`);
        if (requestId !== latestRequestId.current) return;
        setEmails(response.data);
        setMeta(response.meta);
      } catch (error) {
        if (requestId !== latestRequestId.current) return;
        toast.error(
          error instanceof ApiError ? error.message : 'No se pudieron cargar los correos.',
        );
      } finally {
        if (requestId === latestRequestId.current) {
          setLoading(false);
        }
      }
    }

    void run();
  }, [filters, debouncedSender, page]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleDownload(attachment: Attachment) {
    try {
      const { blob, filename } = await apiDownload(`/attachments/${attachment.id}/download`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename ?? attachment.originalName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo descargar el adjunto.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Correos</h1>
        <p className="text-sm text-muted-foreground">
          Correos procesados y adjuntos archivados por cuenta.
        </p>
      </div>

      <div className="grid gap-4 rounded-md border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
          <Label htmlFor="from">Desde</Label>
          <Input
            id="from"
            type="date"
            value={filters.from}
            onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="to">Hasta</Label>
          <Input
            id="to"
            type="date"
            value={filters.to}
            onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sender">Remitente</Label>
          <Input
            id="sender"
            placeholder="nombre o correo"
            value={senderInput}
            onChange={(event) => setSenderInput(event.target.value)}
          />
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

        <div className="flex flex-col gap-2">
          <Label>Adjuntos</Label>
          <Select
            value={filters.hasAttachments}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, hasAttachments: value }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HAS_ATTACHMENTS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {filters.accountId !== 'all' && (
        <ExportZipPanel
          accountId={filters.accountId}
          accountAlias={getAlias(filters.accountId)}
          from={filters.from}
          to={filters.to}
        />
      )}

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Recibido</TableHead>
              <TableHead>Asunto</TableHead>
              <TableHead>Remitente</TableHead>
              <TableHead>Cuenta</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Adjuntos</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : emails.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                  No hay correos que coincidan con los filtros.
                </TableCell>
              </TableRow>
            ) : (
              emails.map((email) => {
                const isExpanded = expandedIds.has(email.id);
                return (
                  <Fragment key={email.id}>
                    <TableRow className="cursor-pointer" onClick={() => toggleExpanded(email.id)}>
                      <TableCell>
                        {isExpanded ? (
                          <ChevronDownIcon
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronRightIcon
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(email.receivedAt)}
                      </TableCell>
                      <TableCell className="max-w-64 truncate" title={email.subject}>
                        {email.subject || '(sin asunto)'}
                      </TableCell>
                      <TableCell className="max-w-48 truncate" title={email.senderEmail}>
                        {email.senderName || email.senderEmail}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {getAlias(email.accountId)}
                      </TableCell>
                      <TableCell>
                        <EmailStatusBadge status={email.status} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {email.attachmentCount}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={7}>
                          {email.errorDetail && (
                            <p className="mb-2 text-sm text-destructive">{email.errorDetail}</p>
                          )}
                          {email.attachments.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              Este correo no tiene adjuntos archivados.
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {email.attachments.map((attachment) => (
                                <div
                                  key={attachment.id}
                                  className="flex items-center justify-between gap-4 rounded-md border border-border bg-card px-3 py-2"
                                >
                                  <div className="flex min-w-0 items-center gap-3">
                                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                                      {attachment.fileType}
                                    </span>
                                    <span
                                      className="truncate text-sm"
                                      title={attachment.originalName}
                                    >
                                      {attachment.originalName}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {formatBytes(attachment.sizeBytes)}
                                    </span>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleDownload(attachment);
                                    }}
                                  >
                                    <DownloadIcon className="size-4" aria-hidden="true" />
                                    Descargar
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={meta.page} limit={meta.limit} total={meta.total} onPageChange={setPage} />
    </div>
  );
}
