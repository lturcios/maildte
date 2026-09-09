import { onlyDigits, stripLeadingZeros } from './digits';

/**
 * Clave canónica del contribuyente (Addendum 11, §2). Decisión CERRADA.
 *
 * El mismo contribuyente aparece como dos partes distintas cuando unos
 * proveedores lo identifican con el NIT de 14 dígitos y otros con el NIT
 * homologado al DUI, de 9. No es un problema de formato: `022560911` y
 * `11022205761034` son dos números válidos de la misma persona, y quitar
 * guiones no los acerca. Lo que sí comparten es el NRC.
 *
 * ```
 * canonicalKey = NRC normalizado    (si está presente)
 *              | NIT de 14 dígitos  (si no)
 *              | DUI de 9 dígitos   (si no)
 * ```
 *
 * **Por qué una cascada y no el NRC a secas.** La evidencia de producción dice
 * que el NRC está en el 100% de los documentos, pero "está en estos 857" no es
 * "está siempre": `nrc` es opcional en el esquema y en el parser. Exigirlo
 * convertiría el primer documento sin NRC en un fallo de ingesta — cambiaríamos
 * un problema de agrupación por uno de pérdida de datos. La cascada degrada en
 * vez de reventar.
 *
 * **Cuando no hay ninguno de los tres, devuelve `null`.** No se inventa una
 * clave ni se cae al identificador crudo: una parte sin clave canónica es
 * exactamente lo que hay que poder ver en la data antes de la fase 2.
 *
 * Función pura: sin Nest, sin Prisma, sin acceso a disco.
 */

/** Longitud del NIT de contribuyente. */
const NIT_LENGTH = 14;

/** Longitud del NIT homologado al DUI de una persona natural. */
const DUI_LENGTH = 9;

/** Lo mínimo que hace falta de una parte para resolver su identidad. */
export interface CanonicalKeyInput {
  /** Número de registro de contribuyente, tal cual vino en el DTE. */
  nrc?: string | null;
  /**
   * Identificador principal tal cual vino en el DTE. Hoy `DteParty.nit` guarda
   * indistintamente el NIT de 14 dígitos o el DUI de 9: la longitud los separa.
   */
  nit?: string | null;
}

/**
 * Resuelve la clave canónica de una parte, o `null` si ninguna de las tres
 * ramas aplica.
 */
export function resolveCanonicalKey(party: CanonicalKeyInput): string | null {
  const nrc = stripLeadingZeros(onlyDigits(party.nrc));
  if (nrc.length > 0) return nrc;

  const id = onlyDigits(party.nit);
  if (id.length === NIT_LENGTH || id.length === DUI_LENGTH) return id;

  // Longitud inesperada (proveedor del exterior, identificador mal formado) o
  // sin identificador: la parte queda sin clave y se ve en la consulta del gate.
  return null;
}
