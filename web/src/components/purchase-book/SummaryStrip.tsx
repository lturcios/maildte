import { AlertTriangleIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';
import type { PurchaseBookSummary } from '@/types/domain';
import { Skeleton } from '@/components/ui/skeleton';

interface SummaryStripProps {
  summary: PurchaseBookSummary | null;
  loading: boolean;
  /** Activa el filtro "sin clasificar" desde el aviso. */
  onShowUnclassified: () => void;
}

interface Tile {
  label: string;
  value: string;
  emphasis?: boolean;
}

/**
 * Totales del filtro activo (Addendum 10, §9.2).
 *
 * Es la lectura que el contador contrasta contra su declaración antes de
 * exportar, así que va arriba de la tabla y no al pie: si los totales no
 * cuadran, no tiene sentido revisar fila por fila.
 *
 * El aviso de compras sin clasificar es accionable a propósito — es la causa
 * más común de que el export se rechace con 422.
 */
export function SummaryStrip({ summary, loading, onShowUnclassified }: SummaryStripProps) {
  if (loading && !summary) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!summary) {
    return null;
  }

  const exentasYNoSujetas = Number(summary.totalExenta || 0) + Number(summary.totalNoSuj || 0);

  const tiles: Tile[] = [
    { label: 'Compras', value: String(summary.documentCount) },
    { label: 'Gravado', value: formatMoney(summary.totalGravada) },
    { label: 'Exento / no sujeto', value: formatMoney(exentasYNoSujetas) },
    { label: 'Crédito fiscal', value: formatMoney(summary.ivaCreditoFiscal) },
    {
      label: 'Total de la operación',
      value: formatMoney(summary.montoTotalOperacion),
      emphasis: true,
    },
  ];

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {/*
        Dos columnas ya desde mobile: cinco tiles apilados empujan la tabla
        fuera de la pantalla y el contador aterriza sin ver una sola compra.
      */}
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className={cn(
              'rounded-lg border border-border bg-card p-4',
              tile.emphasis && 'border-primary/40 bg-primary/5',
            )}
          >
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {tile.label}
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>

      {summary.unclassifiedCount > 0 && (
        <button
          type="button"
          onClick={onShowUnclassified}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 text-left text-sm text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {summary.unclassifiedCount === 1
              ? '1 compra sin clasificar en las columnas Q a T.'
              : `${summary.unclassifiedCount} compras sin clasificar en las columnas Q a T.`}{' '}
            <span className="underline underline-offset-4">Ver solo esas</span>
          </span>
        </button>
      )}

      {summary.jsonAttachmentsWithoutParse > 0 && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Hay {summary.jsonAttachmentsWithoutParse} archivos JSON descargados que todavía no se
          incorporaron al libro. Usá <strong>Reprocesar</strong> para procesarlos.
        </p>
      )}
    </div>
  );
}
