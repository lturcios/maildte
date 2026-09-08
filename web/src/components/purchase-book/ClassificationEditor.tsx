import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiPatch, ApiError } from '@/lib/api-client';
import { labelForCode, usePurchaseBookCatalogsStore } from '@/stores/purchase-book-catalogs-store';
import { resolveEffectiveClassification } from '@/lib/anexo-classification';
import type {
  AnexoDefaults,
  CatalogOption,
  PurchaseDocumentDetail,
  UpdateClassificationInput,
} from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Valor centinela del select para "sin override, usar el default del receptor". */
const USE_DEFAULT = 'default';

type ColumnKey =
  'anexoTipoOperacion' | 'anexoClasificacion' | 'anexoSector' | 'anexoTipoCostoGasto';

type DefaultKey =
  'defaultTipoOperacion' | 'defaultClasificacion' | 'defaultSector' | 'defaultTipoCostoGasto';

interface ColumnSpec {
  key: ColumnKey;
  defaultKey: DefaultKey;
  letter: string;
  label: string;
  catalog: keyof Pick<
    NonNullable<ReturnType<typeof usePurchaseBookCatalogsStore.getState>['catalogs']>,
    'tipoOperacion' | 'clasificacion' | 'sector' | 'tipoCostoGasto'
  >;
}

const COLUMNS: ColumnSpec[] = [
  {
    key: 'anexoTipoOperacion',
    defaultKey: 'defaultTipoOperacion',
    letter: 'Q',
    label: 'Tipo de operación',
    catalog: 'tipoOperacion',
  },
  {
    key: 'anexoClasificacion',
    defaultKey: 'defaultClasificacion',
    letter: 'R',
    label: 'Clasificación',
    catalog: 'clasificacion',
  },
  {
    key: 'anexoSector',
    defaultKey: 'defaultSector',
    letter: 'S',
    label: 'Sector',
    catalog: 'sector',
  },
  {
    key: 'anexoTipoCostoGasto',
    defaultKey: 'defaultTipoCostoGasto',
    letter: 'T',
    label: 'Tipo de costo o gasto',
    catalog: 'tipoCostoGasto',
  },
];

type FormState = Record<ColumnKey, string>;

function toFormState(document: PurchaseDocumentDetail): FormState {
  return {
    anexoTipoOperacion: document.anexoTipoOperacion?.toString() ?? USE_DEFAULT,
    anexoClasificacion: document.anexoClasificacion?.toString() ?? USE_DEFAULT,
    anexoSector: document.anexoSector?.toString() ?? USE_DEFAULT,
    anexoTipoCostoGasto: document.anexoTipoCostoGasto?.toString() ?? USE_DEFAULT,
  };
}

interface ClassificationEditorProps {
  document: PurchaseDocumentDetail;
  canEdit: boolean;
  onSaved: (updated: PurchaseDocumentDetail) => void;
}

/**
 * Editor de las columnas Q a T del Anexo 3 (Addendum 10, ADR-10.5).
 *
 * Estas cuatro columnas NO vienen en el DTE: son criterio contable del
 * contribuyente. Cada select puede dejarse en "usar el default del receptor" o
 * fijar un valor propio para esta compra, y el placeholder muestra cuál sería
 * el default para que la decisión se tome con el dato a la vista.
 */
export function ClassificationEditor({ document, canEdit, onSaved }: ClassificationEditorProps) {
  const catalogs = usePurchaseBookCatalogsStore((state) => state.catalogs);
  const fetchCatalogs = usePurchaseBookCatalogsStore((state) => state.fetchCatalogs);

  const [form, setForm] = useState<FormState>(() => toFormState(document));
  const [nota, setNota] = useState(document.anexoNota ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchCatalogs();
  }, [fetchCatalogs]);

  // Al abrir otra compra en el panel lateral hay que rehidratar el formulario.
  // Se ajusta durante el render (mismo patrón que los filtros de las páginas de
  // listado) y no en un efecto: un setState dentro del efecto encadenaría un
  // render extra después del commit, con el formulario mostrando por un frame
  // los valores del documento anterior.
  const [lastDocumentId, setLastDocumentId] = useState(document.id);
  if (document.id !== lastDocumentId) {
    setLastDocumentId(document.id);
    setForm(toFormState(document));
    setNota(document.anexoNota ?? '');
  }

  const receptorDefaults: AnexoDefaults = document.receptor;
  const effective = resolveEffectiveClassification(document, receptorDefaults, document.fecEmi);

  function optionsFor(spec: ColumnSpec): CatalogOption[] {
    return catalogs?.[spec.catalog] ?? [];
  }

  function defaultHint(spec: ColumnSpec): string {
    const code = receptorDefaults[spec.defaultKey];
    return code === null
      ? 'El receptor no tiene valor por defecto'
      : `Por defecto del receptor: ${labelForCode(optionsFor(spec), code)}`;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: UpdateClassificationInput = {
        anexoTipoOperacion: parseValue(form.anexoTipoOperacion),
        anexoClasificacion: parseValue(form.anexoClasificacion),
        anexoSector: parseValue(form.anexoSector),
        anexoTipoCostoGasto: parseValue(form.anexoTipoCostoGasto),
        anexoNota: nota.trim() === '' ? null : nota.trim(),
      };

      const response = await apiPatch<{ data: PurchaseDocumentDetail }>(
        `/purchase-book/documents/${document.id}/classification`,
        payload,
      );
      onSaved(response.data);
      toast.success('Clasificación guardada.');
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'No se pudo guardar la clasificación.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (effective.preEpoch) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        Las columnas Q a T rigen desde febrero de 2024. Esta compra es de un período anterior, así
        que el anexo llevará <strong>0</strong> en las cuatro y no hay nada que clasificar.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Solo un administrador puede cambiar la clasificación contable.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {COLUMNS.map((spec) => {
          const controlId = `classification-${spec.key}`;
          return (
            <div key={spec.key} className="flex flex-col gap-1.5">
              <Label htmlFor={controlId}>
                <span className="font-mono text-xs text-muted-foreground">{spec.letter}</span>
                {spec.label}
              </Label>
              <Select
                value={form[spec.key]}
                disabled={!canEdit}
                onValueChange={(value) => setForm((prev) => ({ ...prev, [spec.key]: value }))}
              >
                <SelectTrigger id={controlId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={USE_DEFAULT}>Usar el default del receptor</SelectItem>
                  {optionsFor(spec).map((option) => (
                    <SelectItem key={option.code} value={String(option.code)}>
                      {option.code} – {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{defaultHint(spec)}</p>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="classification-nota">Nota interna (opcional)</Label>
        <Textarea
          id="classification-nota"
          value={nota}
          disabled={!canEdit}
          maxLength={300}
          rows={2}
          placeholder="Por qué se clasificó así, para el próximo cierre."
          onChange={(event) => setNota(event.target.value)}
        />
      </div>

      {canEdit && (
        <Button
          type="button"
          className="min-h-11 self-start"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Guardando…' : 'Guardar clasificación'}
        </Button>
      )}
    </div>
  );
}

function parseValue(value: string): number | null {
  return value === USE_DEFAULT ? null : Number(value);
}
