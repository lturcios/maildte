/**
 * Normalización de identificadores tributarios (Addendum 11, §2).
 *
 * Único lugar del libro de compras que decide qué es "el número" de un NIT, un
 * NRC o un DUI. Lo consumen `resolveCanonicalKey()` y `splitSupplierId()`, que
 * antes traía su propia copia del `replace`: dos definiciones de "sin
 * separadores" es la forma garantizada de que el identificador con el que se
 * agrupa un contribuyente no sea el mismo con el que se lo exporta.
 *
 * Módulo puro: sin Nest, sin Prisma, sin acceso a disco.
 */

/**
 * Solo los dígitos del valor. Los emisores de DTE no son consistentes con los
 * separadores (`0614-020390-102-8`, `0614 020390 102 8`, sin nada), y ni el
 * Anexo 3 ni la identidad del contribuyente dependen de cómo lo escribió cada
 * proveedor.
 */
export function onlyDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Quita los ceros a la izquierda. Se aplica SOLO al NRC, que es un correlativo
 * de longitud variable y llega tanto `1435153` como `0001435153`.
 *
 * Deliberadamente NO se aplica al NIT ni al DUI: los dos son de longitud fija
 * (14 y 9) y su cero inicial es parte del identificador — `06140203901028` y
 * `022560911` son NIT y DUI reales de las muestras del proyecto. Recortarlos
 * cambiaría el número y además rompería la clasificación por longitud de la
 * regla E/P del anexo.
 *
 * Devuelve cadena vacía si no quedaba ningún dígito significativo (un valor
 * todo ceros no es un NRC: se trata como ausente, no como el número cero).
 */
export function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+/, '');
}
