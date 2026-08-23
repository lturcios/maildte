import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { mapImapError } from './imap-error';

export interface ImapCredentials {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
}

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

@Injectable()
export class ImapClientFactory {
  create(credentials: ImapCredentials): ImapFlow {
    return new ImapFlow({
      host: credentials.imapHost,
      port: credentials.imapPort,
      secure: credentials.imapSecure,
      auth: { user: credentials.imapUser, pass: credentials.imapPassword },
      logger: false,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  /**
   * Conecta y desconecta sin abrir ningún buzón: valida host, TLS y credenciales
   * (CU-01 / RF-01.2). No debe usarse para sincronizar mensajes.
   */
  async verifyConnection(credentials: ImapCredentials): Promise<{ latencyMs: number }> {
    const client = this.create(credentials);
    const startedAt = Date.now();

    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw mapImapError(err);
    }

    const latencyMs = Date.now() - startedAt;
    await client.logout().catch(() => client.close());
    return { latencyMs };
  }
}
