import { Resolver } from 'dns/promises';

export const MX_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Registros MX de un dominio, ordenados por prioridad (menor primero) y
 * normalizados a minúsculas sin el punto final del FQDN.
 *
 * NUNCA lanza: la detección del proveedor es una ayuda para el usuario, no un
 * requisito del alta de cuenta. Un DNS caído, lento o un dominio inexistente
 * devuelven una lista vacía y el formulario sigue funcionando a mano.
 *
 * Doble techo de tiempo a propósito: el `timeout` del Resolver es por intento y
 * depende de que la librería lo respete; el Promise.race es la garantía dura de
 * que esta función no puede colgar el request de alta más allá del límite.
 */
export async function lookupMxExchanges(
  domain: string,
  timeoutMs: number = MX_LOOKUP_TIMEOUT_MS,
): Promise<string[]> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });

  const query = resolver
    .resolveMx(domain)
    .then((records) =>
      [...records]
        .sort((a, b) => a.priority - b.priority)
        .map((record) => record.exchange.trim().toLowerCase().replace(/\.$/, ''))
        .filter((exchange) => exchange.length > 0),
    )
    .catch(() => []);

  try {
    return await Promise.race([query, deadline]);
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}

/**
 * ¿El servidor de correo `exchange` pertenece al proveedor dueño de `suffix`?
 *
 * La comparación exige el punto de separación: "notgoogle.com" NO debe matchear
 * el sufijo "google.com". Solo el dominio exacto o un subdominio real cuentan.
 */
export function matchesMxSuffix(exchange: string, suffix: string): boolean {
  const normalizedSuffix = suffix.trim().toLowerCase();
  return exchange === normalizedSuffix || exchange.endsWith(`.${normalizedSuffix}`);
}

/** Dominio de un correo, en minúsculas. null si la dirección no tiene forma de correo. */
export function domainOfEmail(email: string): string | null {
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2 || parts[1].length === 0) {
    return null;
  }
  return parts[1];
}
