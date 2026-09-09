import { useState } from 'react';
import { FileSpreadsheetIcon, FileTextIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiDownload, ApiError } from '@/lib/api-client';
import type { PurchaseBookSummary } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface ExportAnexoPanelProps {
  /** Query ya construida con los filtros activos, sin `page` ni `limit`. */
  filtersQuery: string;
  summary: PurchaseBookSummary | null;
  /** `true` cuando el filtro tiene un receptor concreto, no "todos". */
  receptorSelected: boolean;
}

type Format = 'csv' | 'xlsx';

/**
 * Descarga del Anexo 3 "Detalle de Compras" (Addendum 10, §9.2).
 *
 * Exporta exactamente el filtro que está en pantalla: lo que el contador ve es
 * lo que se va a Hacienda. El checkbox de compras sin clasificar aparece solo
 * cuando hace falta, para no ofrecer de entrada un atajo que genera un archivo
 * incompleto.
 *
 * Sin un receptor elegido no hay export posible: el Anexo 3 se presenta por
 * contribuyente y un archivo con varios receptores declararía compras ajenas.
 */
export function ExportAnexoPanel({
  filtersQuery,
  summary,
  receptorSelected,
}: ExportAnexoPanelProps) {
  const [downloading, setDownloading] = useState<Format | null>(null);
  const [allowUnclassified, setAllowUnclassified] = useState(false);

  const total = summary?.documentCount ?? 0;
  const unclassified = summary?.unclassifiedCount ?? 0;
  const disabled = !receptorSelected || total === 0;

  async function handleExport(format: Format) {
    setDownloading(format);
    try {
      const params = new URLSearchParams(filtersQuery);
      params.set('format', format);
      if (allowUnclassified) {
        params.set('allowUnclassified', 'true');
      }

      const { blob, filename } = await apiDownload(`/purchase-book/export?${params.toString()}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename ?? `compras.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.success(total === 1 ? '1 compra exportada.' : `${total} compras exportadas.`);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo generar el archivo del anexo.',
      );
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Anexo 3 — Detalle de compras</h2>
        <p className="text-xs text-muted-foreground">
          {!receptorSelected
            ? 'Elegí un receptor para exportar. El Anexo 3 se presenta por contribuyente: un archivo con varios receptores declararía compras de otra empresa.'
            : total === 0
              ? 'El filtro actual no incluye compras para exportar.'
              : `Se exportarán ${total} ${total === 1 ? 'compra' : 'compras'} del filtro activo.`}
        </p>
      </div>

      {unclassified > 0 && (
        <div className="flex items-start gap-2">
          <input
            id="allow-unclassified"
            type="checkbox"
            checked={allowUnclassified}
            onChange={(event) => setAllowUnclassified(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 rounded-sm border-input accent-primary"
          />
          <Label htmlFor="allow-unclassified" className="text-xs leading-snug font-normal">
            Exportar aunque haya {unclassified}{' '}
            {unclassified === 1 ? 'compra sin clasificar' : 'compras sin clasificar'}. Las columnas
            Q a T saldrán vacías y Hacienda puede rechazar el archivo.
          </Label>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1 sm:flex-none"
          disabled={disabled || downloading !== null}
          onClick={() => void handleExport('csv')}
        >
          <FileTextIcon className="size-4" aria-hidden="true" />
          {downloading === 'csv' ? 'Generando…' : 'CSV (punto y coma)'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1 sm:flex-none"
          disabled={disabled || downloading !== null}
          onClick={() => void handleExport('xlsx')}
        >
          <FileSpreadsheetIcon className="size-4" aria-hidden="true" />
          {downloading === 'xlsx' ? 'Generando…' : 'Excel (XLSX)'}
        </Button>
      </div>
    </div>
  );
}
