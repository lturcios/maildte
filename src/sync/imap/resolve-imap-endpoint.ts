import { EmailAccount, MailProvider } from '@prisma/client';

/** Los tres parámetros de conexión al servidor IMAP, sin credenciales. */
export interface ImapEndpoint {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

/** Una cuenta cargada con su perfil (o null si es de servidor personalizado). */
export type AccountWithProvider = EmailAccount & { provider: MailProvider | null };

/**
 * Punto ÚNICO donde se decide de dónde sale el endpoint IMAP efectivo
 * (Addendum 09, ADR-09.1/09.2) — mismo criterio de "una sola regla, un solo
 * lugar" que StorageService.resolveMonthFolder() con la zona horaria.
 *
 * Con perfil, mandan los datos del perfil: la referencia es VIVA, así que si el
 * SUPERADMIN corrige el host, la siguiente ronda de sincronización ya usa el
 * valor nuevo sin tocar las cuentas. Sin perfil (providerId NULL), mandan las
 * columnas de la propia cuenta: ese es el camino "servidor personalizado".
 *
 * Nadie debe leer `account.imapHost` directo: siempre pasar por acá.
 */
export function pickImapEndpoint(provider: ImapEndpoint | null, own: ImapEndpoint): ImapEndpoint {
  const source = provider ?? own;
  return {
    imapHost: source.imapHost,
    imapPort: source.imapPort,
    imapSecure: source.imapSecure,
  };
}

/** Atajo de pickImapEndpoint para una cuenta ya persistida y cargada con su perfil. */
export function resolveImapEndpoint(account: AccountWithProvider): ImapEndpoint {
  return pickImapEndpoint(account.provider, account);
}
