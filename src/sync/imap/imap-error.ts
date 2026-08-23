export type ImapErrorCode =
  'IMAP_AUTH_FAILED' | 'IMAP_HOST_UNREACHABLE' | 'IMAP_TLS_ERROR' | 'IMAP_UNKNOWN';

export const IMAP_ERROR_HTTP_STATUS: Record<ImapErrorCode, number> = {
  IMAP_AUTH_FAILED: 422,
  IMAP_HOST_UNREACHABLE: 422,
  IMAP_TLS_ERROR: 422,
  IMAP_UNKNOWN: 502,
};

export class ImapConnectionError extends Error {
  constructor(
    public readonly code: ImapErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImapConnectionError';
  }
}

const HOST_UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
]);

export function mapImapError(err: unknown): ImapConnectionError {
  const code = (err as { code?: string } | undefined)?.code;
  const authenticationFailed = (err as { authenticationFailed?: boolean } | undefined)
    ?.authenticationFailed;
  const rawMessage = err instanceof Error ? err.message : 'Error desconocido de conexión IMAP';

  if (authenticationFailed === true || /AUTHENTICATIONFAILED/i.test(rawMessage)) {
    return new ImapConnectionError(
      'IMAP_AUTH_FAILED',
      'Autenticación rechazada por el servidor IMAP',
      err,
    );
  }
  if (code && HOST_UNREACHABLE_CODES.has(code)) {
    return new ImapConnectionError(
      'IMAP_HOST_UNREACHABLE',
      'No se pudo alcanzar el servidor IMAP',
      err,
    );
  }
  if (code && /^(ERR_TLS_|CERT_)/.test(code)) {
    return new ImapConnectionError(
      'IMAP_TLS_ERROR',
      'Error de TLS al conectar con el servidor IMAP',
      err,
    );
  }
  return new ImapConnectionError('IMAP_UNKNOWN', rawMessage, err);
}
