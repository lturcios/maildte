import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { SlidersHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, ApiError } from '@/lib/api-client';
import { formatDateOnly, formatMoney } from '@/lib/format';
import { describeSupplierId, resolveEffectiveClassification } from '@/lib/anexo-classification';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuthStore } from '@/stores/auth-store';
import { useDtePartiesStore } from '@/stores/dte-parties-store';
import type {
  ClassificationFilter,
  Paginated,
  PurchaseBookSummary,
  PurchaseDocumentListItem,
} from '@/types/domain';
import { ClassificationBadge } from '@/components/common/StatusBadges';
import { FiltersPanel } from '@/components/common/FiltersPanel';
import { Pagination } from '@/components/common/Pagination';
import {
  RecordCard,
  RecordCardEmpty,
  RecordCardField,
  RecordCardFields,
  RecordCardHeader,
  RecordCardList,
  RecordCardSkeletons,
} from '@/components/common/RecordCard';
import { ExportAnexoPanel } from '@/components/purchase-book/ExportAnexoPanel';
import { PurchaseDocumentSheet } from '@/components/purchase-book/PurchaseDocumentSheet';
import { ReprocessButton } from '@/components/purchase-book/ReprocessButton';
import { SummaryStrip } from '@/components/purchase-book/SummaryStrip';
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

const LIMIT = 50;
const ALL = 'all';

const CLASSIFICATION_OPTIONS: { value: ClassificationFilter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'classified', label: 'Clasificadas' },
  { value: 'unclassified', label: 'Sin clasificar' },
];

interface Filters {
  receptorId: string;
  emisorId: string;
  accountId: string;
  from: string;
  to: string;
  month: string;
  classification: ClassificationFilter;
}

const DEFAULT_FILTERS: Filters = {
  receptorId: ALL,
  emisorId: ALL,
  accountId: ALL,
  from: '',
  to: '',
  month: '',
  classification: 'all',
};

/**
 * Query de filtros SIN paginación: la usan el listado, el resumen y el export,
 * para que los tres miren exactamente el mismo conjunto de compras.
 */
function buildFiltersQuery(filters: Filters, search: string): string {
  const params = new URLSearchParams();
  if (filters.receptorId !== ALL) params.set('receptorId', filters.receptorId);
  if (filters.emisorId !== ALL) params.set('emisorId', filters.emisorId);
  if (filters.accountId !== ALL) params.set('accountId', filters.accountId);
  if (filters.month) {
    params.set('month', filters.month);
  } else {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (search.trim()) params.set('q', search.trim());
  if (filters.classification !== 'all') params.set('classification', filters.classification);
  return params.toString();
}

function countActiveFilters(filters: Filters, search: string): number {
  return [
    filters.receptorId !== ALL,
    filters.emisorId !== ALL,
    filters.accountId !== ALL,
    filters.from !== '',
    filters.to !== '',
    filters.month !== '',
    filters.classification !== 'all',
    search.trim() !== '',
  ].filter(Boolean).length;
}

/**
 * Libro de compras (Addendum 10, §9.2).
 *
 * Un mismo buzón puede recibir DTE a favor de varios clientes, así que el
 * receptor es un filtro de primera clase y no un dato incidental: sin él, el
 * contador no puede aislar las compras de la empresa que está declarando.
 */
export function LibroComprasPage() {
  const role = useAuthStore((state) => state.user?.role);
  const isAdmin = role === 'ADMIN';

  const { accounts } = useAccounts();
  const emisores = useDtePartiesStore((state) => state.byRole.EMISOR.parties);
  const receptores = useDtePartiesStore((state) => state.byRole.RECEPTOR.parties);
  const fetchParties = useDtePartiesStore((state) => state.fetchParties);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [documents, setDocuments] = useState<PurchaseDocumentListItem[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [summary, setSummary] = useState<PurchaseBookSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const latestRequestId = useRef(0);
  const latestSummaryId = useRef(0);

  useEffect(() => {
    void fetchParties('EMISOR');
    void fetchParties('RECEPTOR');
  }, [fetchParties]);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(searchInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const filtersQuery = buildFiltersQuery(filters, debouncedSearch);

  // Cualquier cambio de filtro vuelve a página 1. Se ajusta durante el render,
  // mismo patrón que CorreosPage, para no encadenar un setState tras el commit.
  const [lastQuery, setLastQuery] = useState(filtersQuery);
  if (filtersQuery !== lastQuery) {
    setLastQuery(filtersQuery);
    setPage(1);
  }

  useEffect(() => {
    const requestId = ++latestRequestId.current;
    const query = `${filtersQuery}${filtersQuery ? '&' : ''}page=${page}&limit=${LIMIT}`;

    async function run() {
      setLoading(true);
      try {
        const response = await apiGet<Paginated<PurchaseDocumentListItem>>(
          `/purchase-book/documents?${query}`,
        );
        if (requestId !== latestRequestId.current) return;
        setDocuments(response.data);
        setMeta(response.meta);
      } catch (error) {
        if (requestId !== latestRequestId.current) return;
        toast.error(
          error instanceof ApiError ? error.message : 'No se pudieron cargar las compras.',
        );
      } finally {
        if (requestId === latestRequestId.current) setLoading(false);
      }
    }

    void run();
  }, [filtersQuery, page, reloadToken]);

  // El resumen no depende de la página: se recalcula solo al cambiar el filtro.
  useEffect(() => {
    const requestId = ++latestSummaryId.current;

    async function run() {
      setSummaryLoading(true);
      try {
        const response = await apiGet<{ data: PurchaseBookSummary }>(
          `/purchase-book/documents/summary?${filtersQuery}`,
        );
        if (requestId !== latestSummaryId.current) return;
        setSummary(response.data);
      } catch (error) {
        if (requestId !== latestSummaryId.current) return;
        toast.error(
          error instanceof ApiError ? error.message : 'No se pudieron calcular los totales.',
        );
      } finally {
        if (requestId === latestSummaryId.current) setSummaryLoading(false);
      }
    }

    void run();
  }, [filtersQuery, reloadToken]);

  const rows = useMemo(
    () =>
      documents.map((document) => ({
        document,
        classification: resolveEffectiveClassification(
          document,
          document.receptor,
          document.fecEmi,
        ),
        supplier: describeSupplierId(document.emisorNit),
      })),
    [documents],
  );

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
    setSearchInput('');
  }

  function refresh() {
    setReloadToken((token) => token + 1);
  }

  const emptyMessage =
    countActiveFilters(filters, debouncedSearch) > 0
      ? 'Ninguna compra coincide con los filtros aplicados.'
      : 'Todavía no hay compras en el libro.';

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-semibold">Libro de compras</h1>
          <p className="text-sm text-muted-foreground">
            Comprobantes de crédito fiscal recibidos, listos para el Anexo 3 del Ministerio de
            Hacienda.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/libro-compras/receptores"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
            Clasificación por receptor
          </Link>
          {isAdmin && (
            <ReprocessButton
              accountId={filters.accountId !== ALL ? filters.accountId : undefined}
              month={filters.month || undefined}
              onFinished={refresh}
            />
          )}
        </div>
      </header>

      <FiltersPanel
        activeCount={countActiveFilters(filters, debouncedSearch)}
        onClear={clearFilters}
        gridClassName="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-receptor">Receptor (cliente)</Label>
          <Select
            value={filters.receptorId}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, receptorId: value }))}
          >
            <SelectTrigger id="filter-receptor" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los receptores</SelectItem>
              {receptores.map((party) => (
                <SelectItem key={party.id} value={party.id}>
                  {party.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-emisor">Proveedor (emisor)</Label>
          <Select
            value={filters.emisorId}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, emisorId: value }))}
          >
            <SelectTrigger id="filter-emisor" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los proveedores</SelectItem>
              {emisores.map((party) => (
                <SelectItem key={party.id} value={party.id}>
                  {party.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-account">Cuenta de correo</Label>
          <Select
            value={filters.accountId}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, accountId: value }))}
          >
            <SelectTrigger id="filter-account" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas las cuentas</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.alias}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-classification">Clasificación</Label>
          <Select
            value={filters.classification}
            onValueChange={(value) =>
              setFilters((prev) => ({ ...prev, classification: value as ClassificationFilter }))
            }
          >
            <SelectTrigger id="filter-classification" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLASSIFICATION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-month">Período (mes)</Label>
          {/*
            `type="date"` recortado a YYYY-MM en vez de `type="month"`: Safari y
            Firefox todavía no lo soportan de forma consistente. Mismo criterio
            que el panel de exportación de correos.
          */}
          <Input
            id="filter-month"
            type="date"
            value={filters.month ? `${filters.month}-01` : ''}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                month: event.target.value ? event.target.value.slice(0, 7) : '',
                from: '',
                to: '',
              }))
            }
          />
          {filters.month && (
            <p className="text-xs text-muted-foreground">Período {filters.month}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-from">Emitidas desde</Label>
          <Input
            id="filter-from"
            type="date"
            value={filters.from}
            disabled={filters.month !== ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-to">Emitidas hasta</Label>
          <Input
            id="filter-to"
            type="date"
            value={filters.to}
            disabled={filters.month !== ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-search">Buscar</Label>
          <Input
            id="filter-search"
            type="search"
            placeholder="N° de control, código o proveedor"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
      </FiltersPanel>

      <SummaryStrip
        summary={summary}
        loading={summaryLoading}
        onShowUnclassified={() =>
          setFilters((prev) => ({ ...prev, classification: 'unclassified' }))
        }
      />

      <ExportAnexoPanel filtersQuery={filtersQuery} summary={summary} />

      {/* Tabla en md+; cards en viewports chicos. */}
      <div className="hidden md:block">
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>N° de control</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Receptor</TableHead>
                <TableHead className="text-right">Gravado</TableHead>
                <TableHead className="text-right whitespace-nowrap">Crédito fiscal</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Clasificación</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && documents.length === 0 ? (
                Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={8}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(({ document, classification, supplier }) => (
                  <TableRow
                    key={document.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(document.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(document.id);
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap">
                      {formatDateOnly(document.fecEmi)}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] whitespace-nowrap">
                      {document.numeroControl}
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-32 truncate" title={document.emisorNombre}>
                        {document.emisorNombre}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {supplier.label} {supplier.value}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-32 truncate" title={document.receptorNombre}>
                        {document.receptorNombre}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(document.totalGravada)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(document.ivaCreditoFiscal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(document.montoTotalOperacion)}
                    </TableCell>
                    <TableCell>
                      <ClassificationBadge
                        codes={classification.codes}
                        preEpoch={classification.preEpoch}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="md:hidden">
        {loading && documents.length === 0 ? (
          <RecordCardSkeletons count={4} />
        ) : rows.length === 0 ? (
          <RecordCardEmpty>{emptyMessage}</RecordCardEmpty>
        ) : (
          <RecordCardList>
            {rows.map(({ document, classification, supplier }) => (
              <RecordCard key={document.id}>
                <RecordCardHeader
                  title={document.emisorNombre}
                  subtitle={`${document.numeroControl} · ${supplier.label} ${supplier.value}`}
                  aside={
                    <ClassificationBadge
                      codes={classification.codes}
                      preEpoch={classification.preEpoch}
                    />
                  }
                  onClick={() => setSelectedId(document.id)}
                />
                <RecordCardFields columns={2}>
                  <RecordCardField label="Emisión">
                    {formatDateOnly(document.fecEmi)}
                  </RecordCardField>
                  <RecordCardField label="Total">
                    {formatMoney(document.montoTotalOperacion)}
                  </RecordCardField>
                  <RecordCardField label="Receptor">{document.receptorNombre}</RecordCardField>
                  <RecordCardField label="Crédito fiscal">
                    {formatMoney(document.ivaCreditoFiscal)}
                  </RecordCardField>
                </RecordCardFields>
              </RecordCard>
            ))}
          </RecordCardList>
        )}
      </div>

      <Pagination page={meta.page} limit={meta.limit} total={meta.total} onPageChange={setPage} />

      <PurchaseDocumentSheet
        documentId={selectedId}
        onClose={() => setSelectedId(null)}
        onClassificationSaved={refresh}
      />
    </div>
  );
}
