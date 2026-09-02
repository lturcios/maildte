import type { SafeAccount } from '@/types/domain';

export interface ImapEndpoint {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

/**
 * Endpoint IMAP vigente de una cuenta. Espejo en el frontend de
 * `resolveImapEndpoint()` del backend (src/sync/imap/resolve-imap-endpoint.ts):
 * con perfil vinculado mandan los datos del catálogo, sin perfil mandan las
 * columnas propias de la cuenta.
 *
 * Ninguna vista debe leer `account.imapHost` directo: con un perfil vinculado
 * esa columna es el último valor escrito, no lo que usa la sincronización.
 */
export function resolveAccountEndpoint(account: SafeAccount): ImapEndpoint {
  const source = account.provider ?? account;
  return {
    imapHost: source.imapHost,
    imapPort: source.imapPort,
    imapSecure: source.imapSecure,
  };
}

/** "imap.gmail.com:993" para listados y tablas. */
export function formatAccountEndpoint(account: SafeAccount): string {
  const { imapHost, imapPort } = resolveAccountEndpoint(account);
  return `${imapHost}:${imapPort}`;
}
