import { mapImapError } from './imap-error';

describe('mapImapError', () => {
  it('mapea authenticationFailed a IMAP_AUTH_FAILED', () => {
    const err = Object.assign(new Error('NO [AUTHENTICATIONFAILED] Invalid credentials'), {
      authenticationFailed: true,
    });

    expect(mapImapError(err).code).toBe('IMAP_AUTH_FAILED');
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT'])(
    'mapea %s a IMAP_HOST_UNREACHABLE',
    (code) => {
      const err = Object.assign(new Error('no se pudo conectar'), { code });

      expect(mapImapError(err).code).toBe('IMAP_HOST_UNREACHABLE');
    },
  );

  it.each(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'])(
    'mapea %s a IMAP_TLS_ERROR',
    (code) => {
      const err = Object.assign(new Error('fallo TLS'), { code });

      expect(mapImapError(err).code).toBe('IMAP_TLS_ERROR');
    },
  );

  it('mapea cualquier otro error a IMAP_UNKNOWN', () => {
    const err = new Error('algo inesperado');

    expect(mapImapError(err).code).toBe('IMAP_UNKNOWN');
  });
});
