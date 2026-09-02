import { AddressInfo, createServer, Server } from 'net';
import { probeImapEndpoint } from './imap-probe';

/**
 * Servidor TCP de juguete: responde con lo que se le indique al conectarse.
 * Alcanza para cubrir el probe sin TLS; el camino TLS comparte todo el código
 * salvo la fábrica del socket.
 */
function startServer(onConnect: (write: (data: string) => void) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      onConnect((data: string) => socket.write(data));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('probeImapEndpoint', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it('reconoce un saludo IMAP válido', async () => {
    server = await startServer((write) => write('* OK [CAPABILITY IMAP4rev1] Servidor listo\r\n'));

    const result = await probeImapEndpoint({
      imapHost: '127.0.0.1',
      imapPort: portOf(server),
      imapSecure: false,
    });

    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.greeting).toContain('* OK');
    }
  });

  it('acepta también el saludo PREAUTH', async () => {
    server = await startServer((write) => write('* PREAUTH IMAP4rev1 sesión ya autenticada\r\n'));

    const result = await probeImapEndpoint({
      imapHost: '127.0.0.1',
      imapPort: portOf(server),
      imapSecure: false,
    });

    expect(result.reachable).toBe(true);
  });

  it('rechaza un puerto abierto que no habla IMAP', async () => {
    // El caso peligroso: el host y el puerto responden, así que un chequeo de
    // "puerto abierto" diría que está todo bien y el perfil quedaría roto.
    server = await startServer((write) => write('HTTP/1.1 200 OK\r\n'));

    const result = await probeImapEndpoint({
      imapHost: '127.0.0.1',
      imapPort: portOf(server),
      imapSecure: false,
    });

    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain('no con un saludo IMAP');
    }
  });

  it('reporta no alcanzable cuando el servidor cierra sin saludar', async () => {
    server = await startServer(() => {
      /* acepta la conexión y no escribe nada; el cierre llega al terminar el test */
    });
    const port = portOf(server);
    await closeServer(server);
    server = null;

    const result = await probeImapEndpoint(
      { imapHost: '127.0.0.1', imapPort: port, imapSecure: false },
      2_000,
    );

    expect(result.reachable).toBe(false);
  });

  it('corta por timeout si el servidor acepta pero nunca responde', async () => {
    server = await startServer(() => {
      /* silencio deliberado */
    });

    const result = await probeImapEndpoint(
      { imapHost: '127.0.0.1', imapPort: portOf(server), imapSecure: false },
      300,
    );

    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain('300 ms');
    }
  });
});
