import { useEffect, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiDownload, apiGet, ApiError } from '@/lib/api-client';
import { formatBytes } from '@/lib/format';
import type { ExportManifestPage } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ExportZipPanelProps {
  accountId: string;
  accountAlias: string;
  /** yyyy-mm-dd o '' — los mismos filtros "Desde"/"Hasta" que ya se ven arriba, en Correos. */
  from: string;
  to: string;
}

/**
 * Arma el scope de /export/*.
 *
 * `receivedFrom`/`receivedTo` filtran por la fecha de RECEPCIÓN del correo, el
 * mismo eje que usa la tabla de Correos y del que se deriva `monthFolder`. No se
 * usan `since`/`until`: esos filtran por `Attachment.createdAt` (cuándo se
 * archivó el adjunto) y son el cursor incremental del CLI maildte-pull, así que
 * un rango de marzo devolvía cero archivos si el sync había corrido en agosto.
 *
 * El atajo de mes completo tiene prioridad y reemplaza el rango.
 */
function buildScope(accountId: string, month: string, from: string, to: string): URLSearchParams {
  const params = new URLSearchParams({ accountId });
  if (month) {
    params.set('month', month);
    return params;
  }
  if (from) params.set('receivedFrom', from);
  if (to) params.set('receivedTo', to);
  return params;
}

function zipSuffix(month: string, from: string, to: string): string {
  if (month) return month;
  if (from && to) return `${from}_${to}`;
  if (from) return `desde_${from}`;
  if (to) return `hasta_${to}`;
  return 'historico';
}

/**
 * Exportación masiva de adjuntos de UNA cuenta a un ZIP (GET /export/archive,
 * ver ExportController). El backend de export no entiende status/sender/
 * hasAttachments (esos filtros solo aplican a la tabla de Correos, no llegan
 * acá) — por eso el conteo real de archivos se pide siempre al manifiesto
 * (GET /export/manifest) en vez de inferirse de esos filtros: es la única
 * forma de saber con certeza si hay algo para descargar en el rango elegido.
 */
export function ExportZipPanel({ accountId, accountAlias, from, to }: ExportZipPanelProps) {
  // <input type="month"> no lo soporta Firefox (cae a texto libre sin validar):
  // se usa type="date" (sí soportado en todos los navegadores, mismo patrón que
  // el resto de la app) y se recorta a "YYYY-MM"; el día elegido no importa.
  const [monthPickerDate, setMonthPickerDate] = useState('');
  const month = monthPickerDate.slice(0, 7);
  const [meta, setMeta] = useState<ExportManifestPage['meta'] | null>(null);
  const [loadingCount, setLoadingCount] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const scope = buildScope(accountId, month, from, to).toString();

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingCount(true);
      setMeta(null);
      try {
        const response = await apiGet<ExportManifestPage>(`/export/manifest?${scope}&limit=1`);
        if (!cancelled) setMeta(response.meta);
      } catch {
        if (!cancelled) setMeta(null);
      } finally {
        if (!cancelled) setLoadingCount(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  async function handleDownload() {
    setDownloading(true);
    try {
      const { blob } = await apiDownload(`/export/archive?${scope}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `export_${accountAlias.replace(/\s+/g, '_')}_${zipSuffix(month, from, to)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'No se pudo generar el ZIP.');
    } finally {
      setDownloading(false);
    }
  }

  const hasFiles = meta !== null && meta.totalFiles > 0;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <div className="flex flex-col gap-2 sm:w-48">
          <Label htmlFor="exportMonth">Mes completo (atajo)</Label>
          <Input
            id="exportMonth"
            type="date"
            value={monthPickerDate}
            onChange={(event) => setMonthPickerDate(event.target.value)}
          />
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground sm:max-w-sm">
          {month
            ? `Se descargan todos los adjuntos de ${month} (el día elegido no importa, solo el mes).`
            : 'Usa "Desde" / "Hasta" de los filtros de arriba (fecha de recepción del correo). Sin ninguno de los dos, descarga todo el histórico de la cuenta.'}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
        <span className="text-sm text-muted-foreground sm:mr-auto">
          {loadingCount
            ? 'Calculando…'
            : meta
              ? `${meta.totalFiles} archivo(s) · ${formatBytes(meta.totalBytes)}`
              : 'No se pudo calcular'}
        </span>
        <Button
          type="button"
          className="w-full sm:w-auto"
          disabled={!hasFiles || downloading || loadingCount}
          onClick={() => void handleDownload()}
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
          {downloading ? 'Generando ZIP…' : 'Descargar ZIP'}
        </Button>
      </div>
    </section>
  );
}
