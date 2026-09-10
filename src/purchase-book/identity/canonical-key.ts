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
 * Rama de la cascada de la que salió la clave, en orden de confianza
 * descendente: `nrc` identifica al contribuyente y es estable entre
 * proveedores; `nit` y `dui` son uno de los identificadores con los que se lo
 * referencia, y el mismo contribuyente puede tener los dos.
 */
export type CanonicalKeySource = 'nrc' | 'nit' | 'dui';

/** Clave canónica resuelta junto con la rama de la que salió. */
export interface CanonicalKeyResolution {
  key: string;
  source: CanonicalKeySource;
}

/**
 * Resuelve la clave canónica de una parte **con su origen**, o `null` si
 * ninguna de las tres ramas aplica.
 *
 * El origen no es un dato decorativo: es lo que permite decidir si una clave
 * entrante puede reemplazar a la que una parte ya tiene. Una clave derivada del
 * NRC vale más que una derivada de un identificador, porque el NRC es el mismo
 * en todos los documentos del contribuyente mientras que el identificador
 * depende de cuál eligió cada proveedor. Sin el origen, un documento sin NRC
 * emitido con el identificador de 9 dígitos le escribiría a la parte ya
 * fusionada la clave del DUI y desharía la fusión desde adentro.
 */
export function resolveCanonicalKeyWithSource(
  party: CanonicalKeyInput,
): CanonicalKeyResolution | null {
  const nrc = stripLeadingZeros(onlyDigits(party.nrc));
  if (nrc.length > 0) return { key: nrc, source: 'nrc' };

  const id = onlyDigits(party.nit);
  if (id.length === NIT_LENGTH) return { key: id, source: 'nit' };
  if (id.length === DUI_LENGTH) return { key: id, source: 'dui' };

  // Longitud inesperada (proveedor del exterior, identificador mal formado) o
  // sin identificador: la parte queda sin clave y se ve en la consulta del gate.
  return null;
}

/**
 * Resuelve la clave canónica de una parte, o `null` si ninguna de las tres
 * ramas aplica. Es `resolveCanonicalKeyWithSource()` sin el origen, para los
 * llamadores a los que solo les interesa la clave.
 */
export function resolveCanonicalKey(party: CanonicalKeyInput): string | null {
  return resolveCanonicalKeyWithSource(party)?.key ?? null;
}
