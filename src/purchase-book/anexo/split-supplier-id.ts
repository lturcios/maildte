/**
 * Regla E/P del Anexo 3 (Addendum 10, §3.1).
 *
 * Las columnas E (NIT o NRC del proveedor) y P (DUI del proveedor) son
 * mutuamente excluyentes: si una lleva valor, la otra va vacía. El instructivo
 * de Hacienda decide por tipo de contribuyente, pero en el DTE eso no viene
 * declarado. Lo que sí distingue es la longitud del identificador:
 *
 * - 14 dígitos → NIT de contribuyente → columna E.
 * - 9 dígitos  → NIT homologado al DUI de una persona natural → columna P.
 *
 * Ambas muestras reales del proyecto tienen emisores de 9 dígitos
 * (`040522092`, `027561310`) y receptores de 14 (`12171609731022`), que es
 * exactamente el caso que la regla tiene que resolver.
 *
 * Cualquier otra longitud (proveedor del exterior, emisor mal formado) se
 * exporta en E tal cual y se cuenta como anomalía, para que el contador la vea
 * en el resumen antes de enviar el archivo. Nunca se inventa un identificador.
 */

export interface SupplierId {
  /** Columna E. Cadena vacía cuando corresponde llenar el DUI. */
  nit: string;
  /** Columna P. Cadena vacía cuando corresponde llenar el NIT. */
  dui: string;
  /** `true` si la longitud no es 9 ni 14: hay que revisar el documento a mano. */
  anomalous: boolean;
}

const NIT_LENGTH = 14;
const DUI_LENGTH = 9;

/**
 * Separa el identificador del proveedor en las columnas E y P.
 *
 * Quita guiones, pleca y cualquier separador antes de medir: el instructivo
 * exige el número sin separadores y los emisores no son consistentes.
 */
export function splitSupplierId(raw: string | null | undefined): SupplierId {
  const digits = (raw ?? '').replace(/\D/g, '');

  if (digits.length === NIT_LENGTH) {
    return { nit: digits, dui: '', anomalous: false };
  }

  if (digits.length === DUI_LENGTH) {
    return { nit: '', dui: digits, anomalous: false };
  }

  // Longitud inesperada: se informa en E y se marca para revisión manual.
  return { nit: digits, dui: '', anomalous: true };
}
