import { useEffect, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, ApiError } from '@/lib/api-client';
import { formatDateOnly, formatDateTime, formatMoney } from '@/lib/format';
import { describeSupplierId } from '@/lib/anexo-classification';
import { useAuthStore } from '@/stores/auth-store';
import { labelForCode, usePurchaseBookCatalogsStore } from '@/stores/purchase-book-catalogs-store';
import type { PurchaseDocumentDetail } from '@/types/domain';
import { ClassificationEditor } from './ClassificationEditor';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PurchaseDocumentSheetProps {
  documentId: string | null;
  onClose: () => void;
  /** Se dispara al guardar la clasificación, para refrescar el listado. */
  onClassificationSaved: () => void;
}

/** Par etiqueta/valor de las secciones de datos. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{value ?? '—'}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Detalle completo de una compra (Addendum 10, §9.2).
 *
 * Panel lateral ancho en escritorio y pantalla completa en móvil: son muchos
 * campos y una tabla de ítems, que en un diálogo centrado obligarían a scroll
 * dentro de scroll.
 */
export function PurchaseDocumentSheet({
  documentId,
  onClose,
  onClassificationSaved,
}: PurchaseDocumentSheetProps) {
  const role = useAuthStore((state) => state.user?.role);
  const catalogs = usePurchaseBookCatalogsStore((state) => state.catalogs);
  const isAdmin = role === 'ADMIN';

  /**
   * El documento se guarda junto al id que lo pidió. Así, al abrir otra compra,
   * los datos viejos dejan de renderizarse por comparación de id y no hace falta
   * limpiarlos con un setState dentro del efecto (que dispararía un render en
   * cascada). `onClose` tampoco entra en las dependencias: el padre lo pasa como
   * arrow inline, o sea una función nueva por render, y el efecto se
   * re-ejecutaría en bucle pidiendo el detalle una y otra vez.
   */
  const [loaded, setLoaded] = useState<{ id: string; data: PurchaseDocumentDetail } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!documentId) {
      return;
    }

    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const response = await apiGet<{ data: PurchaseDocumentDetail }>(
          `/purchase-book/documents/${documentId}`,
        );
        if (!cancelled) setLoaded({ id: documentId as string, data: response.data });
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof ApiError
              ? error.message
              : 'No se pudo cargar el detalle de la compra.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const document = loaded !== null && loaded.id === documentId ? loaded.data : null;
  const supplier = document ? describeSupplierId(document.emisorNit) : null;

  return (
    <Sheet open={documentId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto bg-background text-foreground sm:w-[min(46rem,95vw)]"
      >
        <div className="flex flex-col gap-6 p-6">
          {loading && !document ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : document ? (
            <>
              <header className="flex flex-col gap-1 pr-10">
                <SheetTitle className="text-base">{document.emisorNombre}</SheetTitle>
                <SheetDescription>
                  {document.numeroControl} · {formatDateOnly(document.fecEmi)}
                </SheetDescription>
              </header>

              <Section title="Identificación">
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Fecha de emisión" value={formatDateOnly(document.fecEmi)} />
                  <Field label="Hora" value={document.horEmi} />
                  <Field
                    label="Tipo de documento"
                    value={
                      catalogs?.tipoDocumento.find((item) => item.code === document.tipoDte)
                        ?.label ?? document.tipoDte
                    }
                  />
                  <Field label="Número de control" value={document.numeroControl} />
                  <Field
                    label="Código de generación"
                    value={<span className="font-mono text-xs">{document.codigoGeneracion}</span>}
                  />
                  <Field label="Versión del esquema" value={`v${document.version}`} />
                  <Field
                    label="Condición de la operación"
                    value={labelForCode(catalogs?.condicionOperacion, document.condicionOperacion)}
                  />
                  <Field label="Moneda" value={document.tipoMoneda} />
                  <Field
                    label="Sello de recepción"
                    value={
                      document.selloRecibido ? (
                        <span className="font-mono text-xs break-all">
                          {document.selloRecibido}
                        </span>
                      ) : null
                    }
                  />
                </dl>
              </Section>

              <Section title="Proveedor (emisor)">
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Nombre" value={document.emisorNombre} />
                  <Field
                    label={supplier ? supplier.label : 'Identificador'}
                    value={<span className="font-mono">{supplier?.value}</span>}
                  />
                  <Field label="NRC" value={document.emisorNrc} />
                  <Field label="Nombre comercial" value={document.emisorNombreComercial} />
                  <Field label="Actividad" value={document.emisor.descActividad} />
                  <Field label="Establecimiento" value={document.emisorCodEstable} />
                </dl>
              </Section>

              <Section title="Receptor (cliente)">
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Nombre" value={document.receptorNombre} />
                  <Field
                    label="NIT"
                    value={<span className="font-mono">{document.receptorNit}</span>}
                  />
                  <Field label="NRC" value={document.receptorNrc} />
                  <Field label="Nombre comercial" value={document.receptorNombreComercial} />
                  <Field label="Actividad" value={document.receptor.descActividad} />
                </dl>
              </Section>

              <Section title="Resumen">
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Gravado" value={formatMoney(document.totalGravada)} />
                  <Field label="Exento" value={formatMoney(document.totalExenta)} />
                  <Field label="No sujeto" value={formatMoney(document.totalNoSuj)} />
                  <Field label="Descuentos" value={formatMoney(document.totalDescu)} />
                  <Field label="Subtotal" value={formatMoney(document.subTotal)} />
                  <Field
                    label="Crédito fiscal (IVA)"
                    value={formatMoney(document.ivaCreditoFiscal)}
                  />
                  <Field label="IVA retenido" value={formatMoney(document.ivaRetenido)} />
                  <Field label="IVA percibido" value={formatMoney(document.ivaPercibido)} />
                  <Field label="Retención de renta" value={formatMoney(document.retencionRenta)} />
                  <Field
                    label="Monto total de la operación"
                    value={
                      <span className="font-semibold">
                        {formatMoney(document.montoTotalOperacion)}
                      </span>
                    }
                  />
                  <Field label="Total a pagar" value={formatMoney(document.totalPagar)} />
                  <Field label="Total en letras" value={document.totalLetras} />
                </dl>
                {document.observaciones && (
                  <p className="text-sm text-muted-foreground">{document.observaciones}</p>
                )}
              </Section>

              <Section title={`Ítems (${document.items.length})`}>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Descripción</TableHead>
                        <TableHead className="text-right">Cant.</TableHead>
                        <TableHead className="text-right">Precio</TableHead>
                        <TableHead className="text-right">Gravado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {document.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-muted-foreground">{item.numItem}</TableCell>
                          <TableCell>
                            <span className="block">{item.descripcion}</span>
                            {item.codigo && (
                              <span className="text-xs text-muted-foreground">
                                Código {item.codigo}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{item.cantidad}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(item.precioUni)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(item.ventaGravada)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Section>

              {document.taxes.length > 0 && (
                <Section title="Tributos">
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {document.taxes.map((tax) => (
                      <Field
                        key={tax.id}
                        label={`${tax.codigo} · ${tax.descripcion}`}
                        value={formatMoney(tax.valor)}
                      />
                    ))}
                  </dl>
                </Section>
              )}

              {document.payments.length > 0 && (
                <Section title="Pagos">
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {document.payments.map((payment) => (
                      <Field
                        key={payment.id}
                        label={
                          catalogs?.formaPago.find((item) => item.code === payment.codigo)?.label ??
                          `Forma ${payment.codigo}`
                        }
                        value={formatMoney(payment.montoPago)}
                      />
                    ))}
                  </dl>
                </Section>
              )}

              <Section title="Clasificación para el Anexo 3">
                <ClassificationEditor
                  document={document}
                  canEdit={isAdmin}
                  onSaved={(updated) => {
                    setLoaded({ id: updated.id, data: updated });
                    onClassificationSaved();
                  }}
                />
                {document.classifiedAt && (
                  <p className="text-xs text-muted-foreground">
                    Última clasificación: {formatDateTime(document.classifiedAt)}
                  </p>
                )}
              </Section>

              {isAdmin && document.rawJson !== null && (
                <Collapsible className="rounded-lg border border-border">
                  <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-4 text-sm font-medium">
                    Ver el JSON original del DTE
                    <ChevronDownIcon
                      className="ml-auto size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="max-h-80 overflow-auto border-t border-border p-4 font-mono text-xs">
                      {JSON.stringify(document.rawJson, null, 2)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
