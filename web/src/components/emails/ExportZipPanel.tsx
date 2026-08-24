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

function sinceFromDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00.000Z`).toISOString();
}

/** "Hasta" es inclusivo del día completo (a diferencia del filtro de la tabla de Correos). */
function untilFromDate(dateOnly: string): string {
  return new Date(`${dateOnly}T23:59:59.999Z`).toISOString();
}

/** Arma el scope de accountId + since/until/month para /export/*. El mes completo tiene prioridad. */
function buildScope(accountId: string, month: string, from: string, to: string): URLSearchParams {
  const params = new URLSearchParams({ accountId });
  if (month) {
    params.set('month', month);
    return params;
  }
  if (from) params.set('since', sinceFromDate(from));
  if (to) params.set('until', untilFromDate(to));
  return params;
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
      link.download = `export_${accountAlias.replace(/\s+/g, '_')}_${month || 'periodo'}.zip`;
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
    <div className="flex flex-wrap items-end gap-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="exportMonth">Mes completo (atajo)</Label>
        <Input
          id="exportMonth"
          type="date"
          value={monthPickerDate}
          onChange={(event) => setMonthPickerDate(event.target.value)}
        />
      </div>

      <p className="max-w-sm text-xs text-muted-foreground">
        {month
          ? `Se descargan todos los adjuntos de ${month} (el día elegido no importa, solo el mes).`
          : 'Usa "Desde" / "Hasta" de los filtros de arriba (fecha en que se archivó el adjunto, no la de recepción del correo). Sin ninguno de los dos, descarga todo el histórico de la cuenta.'}
      </p>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {loadingCount
            ? 'Calculando…'
            : meta
              ? `${meta.totalFiles} archivo(s) · ${formatBytes(meta.totalBytes)}`
              : 'No se pudo calcular'}
        </span>
        <Button
          type="button"
          disabled={!hasFiles || downloading || loadingCount}
          onClick={() => void handleDownload()}
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
          {downloading ? 'Generando ZIP…' : 'Descargar ZIP'}
        </Button>
      </div>
    </div>
  );
}
