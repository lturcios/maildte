import { EmailAccount, MailProvider } from '@prisma/client';
import {
  AccountWithProvider,
  pickImapEndpoint,
  resolveImapEndpoint,
} from './resolve-imap-endpoint';

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    id: 'provider-1',
    key: 'gmail',
    name: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    defaultMailbox: 'INBOX',
    strict: true,
    notes: null,
    helpUrl: null,
    active: true,
    sortOrder: 10,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function account(overrides: Partial<AccountWithProvider> = {}): AccountWithProvider {
  const base = {
    id: 'account-1',
    tenantId: 'tenant-1',
    alias: 'Compras',
    email: 'compras@ltsoft.us',
    folderName: 'compras_ltsoft_us',
    providerId: null,
    imapHost: 'mail.ltsoft.us',
    imapPort: 143,
    imapSecure: false,
    imapUser: 'compras@ltsoft.us',
    imapPassEnc: 'iv:tag:cipher',
    mailbox: 'INBOX',
    syncInterval: 300,
    syncFromDate: new Date('2026-01-01T00:00:00Z'),
    lastUid: 0,
    uidValidity: null,
    lastSyncAt: null,
    lastError: null,
    status: 'ACTIVA',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as unknown as EmailAccount;

  return { ...base, provider: null, ...overrides };
}

describe('resolveImapEndpoint', () => {
  it('usa los datos del perfil cuando la cuenta tiene uno vinculado', () => {
    const withProvider = account({ providerId: 'provider-1', provider: provider() });

    expect(resolveImapEndpoint(withProvider)).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
    });
  });

  it('ignora por completo las columnas propias cuando hay perfil', () => {
    // La cuenta trae host/puerto/TLS viejos y contradictorios: no deben filtrarse.
    const withProvider = account({
      providerId: 'provider-1',
      provider: provider(),
      imapHost: 'host.viejo.example',
      imapPort: 143,
      imapSecure: false,
    });

    const endpoint = resolveImapEndpoint(withProvider);

    expect(endpoint.imapHost).not.toBe('host.viejo.example');
    expect(endpoint.imapPort).toBe(993);
    expect(endpoint.imapSecure).toBe(true);
  });

  it('usa las columnas de la cuenta cuando no hay perfil (servidor personalizado)', () => {
    expect(resolveImapEndpoint(account())).toEqual({
      imapHost: 'mail.ltsoft.us',
      imapPort: 143,
      imapSecure: false,
    });
  });

  it('refleja de inmediato un cambio del perfil: la referencia es viva (ADR-09.1)', () => {
    const before = account({ providerId: 'provider-1', provider: provider() });
    const after = account({
      providerId: 'provider-1',
      provider: provider({ imapHost: 'imap.corregido.example', imapPort: 143, imapSecure: false }),
    });

    expect(resolveImapEndpoint(before).imapHost).toBe('imap.gmail.com');
    expect(resolveImapEndpoint(after)).toEqual({
      imapHost: 'imap.corregido.example',
      imapPort: 143,
      imapSecure: false,
    });
  });
});

describe('pickImapEndpoint', () => {
  const own = { imapHost: 'mail.propio.example', imapPort: 143, imapSecure: false };

  it('devuelve solo los tres campos del endpoint, sin arrastrar el resto del perfil', () => {
    expect(pickImapEndpoint(provider(), own)).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
    });
  });

  it('cae en los valores propios cuando el perfil es null', () => {
    expect(pickImapEndpoint(null, own)).toEqual(own);
  });

  it('conserva imapSecure=false del perfil en vez de tratarlo como ausente', () => {
    // Guarda contra una implementación con ?? o || sobre cada campo suelto:
    // un perfil de puerto 143 sin TLS es válido y no debe caer al valor propio.
    const plain = provider({ imapHost: 'imap.plano.example', imapPort: 143, imapSecure: false });

    expect(pickImapEndpoint(plain, { imapHost: 'x', imapPort: 993, imapSecure: true })).toEqual({
      imapHost: 'imap.plano.example',
      imapPort: 143,
      imapSecure: false,
    });
  });
});
