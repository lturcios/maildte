/**
 * Precedencia de la actividad económica de una compra (Addendum 11, §7.4).
 *
 *   override del documento  →  default por (proveedor, receptor)  →  sin clasificar
 *
 * La actividad NO sale del DTE. `receptorCodActividad` lo escribe el **emisor**
 * copiándolo del registro de Hacienda, así que responde "cómo está inscripto el
 * comprador", no "a qué unidad de negocio va esta compra" — que es lo único que
 * el contador necesita y lo único que el proveedor no puede saber. La revisión
 * de la fase 3 lo midió: un solo restaurante aparecía con cuatro códigos porque
 * dos proveedores elegían otra etiqueta para el mismo negocio.
 *
 * Por eso la actividad es un dato que el contribuyente declara y el sistema
 * hereda: lo declara una vez por proveedor (el default) y lo corrige documento
 * a documento cuando ese proveedor le sirvió a otra unidad de negocio.
 *
 * Módulo puro, como `resolve-classification.ts`: sin Nest, sin Prisma, sin
 * disco. La etapa que encadena Q–T a la actividad resuelta es la rebanada
 * siguiente.
 */

/** De dónde salió la actividad efectiva de un documento. */
export type ActivitySource = 'override' | 'supplier-default' | 'missing';

/** Lo que un documento aporta a la resolución. */
export interface ActivityOverrideInput {
  /** Override del documento (`PurchaseDocument.activityId`), `null` si no tiene. */
  activityId: string | null;
  /** Proveedor del documento: la clave del default junto con el receptor. */
  emisorId: string;
}

export interface ResolvedActivity {
  /** Actividad efectiva, o `null` si quedó sin clasificar. */
  activityId: string | null;
  source: ActivitySource;
}

/**
 * Resuelve la actividad efectiva de un documento.
 *
 * @param supplierDefaultActivityId default del proveedor para ESE receptor, o
 *   `null` si ese proveedor todavía no está mapeado. Quien llama es responsable
 *   de que el default corresponda al receptor del documento: un default de otro
 *   contribuyente aplicaría su criterio a estas compras, que es exactamente la
 *   fuga que el modelo ternario existe para impedir.
 */
export function resolveActivity(
  doc: ActivityOverrideInput,
  supplierDefaultActivityId: string | null,
): ResolvedActivity {
  if (doc.activityId !== null) {
    return { activityId: doc.activityId, source: 'override' };
  }
  if (supplierDefaultActivityId !== null) {
    return { activityId: supplierDefaultActivityId, source: 'supplier-default' };
  }
  return { activityId: null, source: 'missing' };
}

/**
 * Clave del mapeo de proveedores dentro de un receptor.
 *
 * El default es ternario —(tenant, receptor, proveedor)— y en una página del
 * listado puede haber documentos de varios receptores. Indexar solo por
 * `emisorId` mezclaría el criterio de dos contribuyentes distintos.
 */
export function supplierDefaultKey(receptorId: string, emisorId: string): string {
  return `${receptorId}\u0000${emisorId}`;
}
