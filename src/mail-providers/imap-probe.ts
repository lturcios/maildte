import { connect as netConnect } from 'net';
import { connect as tlsConnect } from 'tls';
import { ImapEndpoint } from '../sync/imap/resolve-imap-endpoint';

const PROBE_TIMEOUT_MS = 8_000;
const GREETING_MAX_BYTES = 512;

export type ProbeResult =
  | { reachable: true; latencyMs: number; greeting: string }
  | { reachable: false; latencyMs: number; reason: string };

/**
 * Verificación de alcance de un endpoint IMAP, SIN credenciales (Addendum 09):
 * un perfil del catálogo no tiene usuario ni contraseña, así que no se puede
 * usar ImapClientFactory.verifyConnection. Abre el socket, espera el saludo del
 * servidor y corta.
 *
 * No valida que las credenciales de nadie funcionen: solo descarta el typo en
 * host o puerto antes de que un cambio del SUPERADMIN se propague en caliente a
 * las cuentas vinculadas.
 *
 * TLS con verificación de certificado por defecto (regla 20 de CLAUDE.md: nunca
 * rejectUnauthorized: false).
 */
export async function probeImapEndpoint(
  endpoint: ImapEndpoint,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = endpoint.imapSecure
      ? tlsConnect({
          host: endpoint.imapHost,
          port: endpoint.imapPort,
          servername: endpoint.imapHost,
        })
      : netConnect({ host: endpoint.imapHost, port: endpoint.imapPort });

    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const elapsed = (): number => Date.now() - startedAt;

    const timer = setTimeout(
      () =>
        finish({
          reachable: false,
          latencyMs: elapsed(),
          reason: `El servidor no respondió en ${timeoutMs} ms`,
        }),
      timeoutMs,
    );

    socket.on('error', (err: Error) => {
      finish({ reachable: false, latencyMs: elapsed(), reason: err.message });
    });

    socket.on('data', (chunk: Buffer) => {
      const greeting = chunk.subarray(0, GREETING_MAX_BYTES).toString('utf8').split('\r\n')[0];

      // Un servidor IMAP saluda con "* OK" o "* PREAUTH" (RFC 3501 §7.1).
      // Cualquier otra cosa es un puerto abierto que no habla IMAP: alcanzable
      // no alcanza, tiene que ser el servicio correcto.
      if (/^\* (OK|PREAUTH)/i.test(greeting)) {
        finish({ reachable: true, latencyMs: elapsed(), greeting });
      } else {
        finish({
          reachable: false,
          latencyMs: elapsed(),
          reason: 'El puerto responde pero no con un saludo IMAP',
        });
      }
    });

    socket.on('close', () => {
      finish({
        reachable: false,
        latencyMs: elapsed(),
        reason: 'La conexión se cerró antes del saludo del servidor',
      });
    });
  });
}
