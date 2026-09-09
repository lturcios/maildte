import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth-store';
import { useDtePartiesStore } from '@/stores/dte-parties-store';
import { usePurchaseBookCatalogsStore } from '@/stores/purchase-book-catalogs-store';
import type { AnexoDefaults, CatalogOption, DteParty } from '@/types/domain';
import {
  RecordCard,
  RecordCardEmpty,
  RecordCardFields,
  RecordCardHeader,
  RecordCardList,
  RecordCardSkeletons,
} from '@/components/common/RecordCard';
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

/** Valor centinela para "sin default". */
const NONE = 'none';

type DefaultKey = keyof AnexoDefaults;

interface ColumnSpec {
  key: DefaultKey;
  letter: string;
  label: string;
  catalog: 'tipoOperacion' | 'clasificacion' | 'sector' | 'tipoCostoGasto';
}

const COLUMNS: ColumnSpec[] = [
  {
    key: 'defaultTipoOperacion',
    letter: 'Q',
    label: 'Tipo de operación',
    catalog: 'tipoOperacion',
  },
  { key: 'defaultClasificacion', letter: 'R', label: 'Clasificación', catalog: 'clasificacion' },
  { key: 'defaultSector', letter: 'S', label: 'Sector', catalog: 'sector' },
  {
    key: 'defaultTipoCostoGasto',
    letter: 'T',
    label: 'Tipo de costo o gasto',
    catalog: 'tipoCostoGasto',
  },
];

interface DefaultSelectProps {
  party: DteParty;
  spec: ColumnSpec;
  options: CatalogOption[];
  disabled: boolean;
  onChange: (key: DefaultKey, value: number | null) => void;
  compact?: boolean;
}

/** Select con autosave: cada cambio guarda de inmediato, sin botón intermedio. */
function DefaultSelect({
  party,
  spec,
  options,
  disabled,
  onChange,
  compact = false,
}: DefaultSelectProps) {
  const controlId = `${party.id}-${spec.key}`;
  const current = party[spec.key];

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={controlId} className={compact ? 'text-xs' : 'sr-only'}>
        <span className="font-mono text-xs text-muted-foreground">{spec.letter}</span>
        {spec.label}
      </Label>
      <Select
        value={current === null ? NONE : String(current)}
        disabled={disabled}
        onValueChange={(value) => onChange(spec.key, value === NONE ? null : Number(value))}
      >
        <SelectTrigger id={controlId} className="w-full min-w-32" aria-label={spec.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin definir</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.code} value={String(option.code)}>
              {option.code} – {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Defaults del Anexo 3 por receptor (Addendum 10, §9.3).
 *
 * Las columnas Q a T no vienen en el DTE. Configurarlas una vez por cliente
 * evita clasificar compra por compra: cada documento hereda el default de su
 * receptor y solo se corrige cuando esa compra puntual es distinta.
 */
export function ReceptoresPage() {
  const role = useAuthStore((state) => state.user?.role);
  const canEdit = role === 'ADMIN';

  const receptores = useDtePartiesStore((state) => state.byRole.RECEPTOR.parties);
  const loading = useDtePartiesStore((state) => state.byRole.RECEPTOR.loading);
  const loaded = useDtePartiesStore((state) => state.byRole.RECEPTOR.loaded);
  const fetchParties = useDtePartiesStore((state) => state.fetchParties);
  const updateDefaults = useDtePartiesStore((state) => state.updateDefaults);

  const catalogs = usePurchaseBookCatalogsStore((state) => state.catalogs);
  const fetchCatalogs = usePurchaseBookCatalogsStore((state) => state.fetchCatalogs);

  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    void fetchParties('RECEPTOR');
    void fetchCatalogs();
  }, [fetchParties, fetchCatalogs]);

  async function handleChange(party: DteParty, key: DefaultKey, value: number | null) {
    setSavingId(party.id);
    try {
      await updateDefaults(party.id, { [key]: value });
      toast.success(`Clasificación por defecto guardada para ${party.nombre}.`);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo guardar el valor por defecto.',
      );
      // El store solo se actualiza con la respuesta del servidor, así que un
      // fallo deja los selects mostrando el valor previo sin trabajo extra.
    } finally {
      setSavingId(null);
    }
  }

  function optionsFor(spec: ColumnSpec): CatalogOption[] {
    return catalogs?.[spec.catalog] ?? [];
  }

  const showSkeleton = loading && !loaded;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          to="/libro-compras"
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Volver al libro de compras
        </Link>
        <h1 className="font-display text-2xl font-semibold">Clasificación por receptor</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Las columnas Q a T del Anexo 3 (tipo de operación, clasificación, sector y tipo de costo o
          gasto) no vienen en el DTE: son criterio contable del contribuyente. Lo que definas acá se
          aplica a todas las compras de ese receptor. Una compra puntual puede sobrescribirlo desde
          su detalle, y ese valor propio siempre gana sobre el default.
        </p>
        {!canEdit && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Solo un administrador puede cambiar estos valores.
          </p>
        )}
      </header>

      <div className="hidden md:block">
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receptor</TableHead>
                <TableHead className="text-right">Compras</TableHead>
                {COLUMNS.map((spec) => (
                  <TableHead key={spec.key}>
                    <span className="font-mono text-xs text-muted-foreground">{spec.letter}</span>{' '}
                    {spec.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton ? (
                Array.from({ length: 3 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-9 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : receptores.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    Todavía no se registró ningún receptor. Aparecen automáticamente al procesarse
                    el primer DTE a su nombre.
                  </TableCell>
                </TableRow>
              ) : (
                receptores.map((party) => (
                  <TableRow key={party.id}>
                    <TableCell>
                      <span className="block font-medium">{party.nombre}</span>
                      <span className="font-mono text-xs text-muted-foreground">{party.nit}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {party._count.receptorDocuments}
                    </TableCell>
                    {COLUMNS.map((spec) => (
                      <TableCell key={spec.key}>
                        <DefaultSelect
                          party={party}
                          spec={spec}
                          options={optionsFor(spec)}
                          disabled={!canEdit || savingId === party.id}
                          onChange={(key, value) => void handleChange(party, key, value)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="md:hidden">
        {showSkeleton ? (
          <RecordCardSkeletons count={3} />
        ) : receptores.length === 0 ? (
          <RecordCardEmpty>
            Todavía no se registró ningún receptor. Aparecen automáticamente al procesarse el primer
            DTE a su nombre.
          </RecordCardEmpty>
        ) : (
          <RecordCardList>
            {receptores.map((party) => (
              <RecordCard key={party.id}>
                <RecordCardHeader
                  title={party.nombre}
                  subtitle={party.nit}
                  aside={
                    <span className="text-xs text-muted-foreground">
                      {party._count.receptorDocuments} compras
                    </span>
                  }
                />
                <RecordCardFields>
                  {COLUMNS.map((spec) => (
                    <DefaultSelect
                      key={spec.key}
                      party={party}
                      spec={spec}
                      options={optionsFor(spec)}
                      disabled={!canEdit || savingId === party.id}
                      onChange={(key, value) => void handleChange(party, key, value)}
                      compact
                    />
                  ))}
                </RecordCardFields>
              </RecordCard>
            ))}
          </RecordCardList>
        )}
      </div>
    </div>
  );
}
