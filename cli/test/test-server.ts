import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { buildZip } from './zip-writer';

export interface TestManifestEntry {
  attachmentId: string;
  relativePath: string;
  content: Buffer;
  /** Hash anunciado por el manifiesto. A propósito puede ser distinto del hash real del contenido
   * para simular un archivo corrupto/adulterado en tránsito. */
  sha256: string;
  createdAt: string;
  fileType: 'JSON' | 'PDF';
  /** Bytes que /export/archive incluye para esta entrada dentro del ZIP, si difieren de `content`
   * (por ejemplo para verificar que el cliente jamás sobrescribe un archivo que ya tenía). */
  archiveContent?: Buffer;
}

export interface TestServer {
  url: string;
  downloadRequests: Record<string, number>;
  archiveRequests: number;
  close: () => Promise<void>;
}

export function startTestServer(entries: TestManifestEntry[]): Promise<TestServer> {
  const downloadRequests: Record<string, number> = {};
  const archiveState = { count: 0 };

  const server: Server = createServer((req, res) => {
    // fetch/undici reutiliza sockets keep-alive por defecto, lo que deja el event loop
    // vivo indefinidamente en un test runner de corta duración; forzamos cierre por request.
    res.setHeader('Connection', 'close');
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/export/manifest') {
      const since = url.searchParams.get('since');
      const cursorId = url.searchParams.get('cursorId');
      const limit = Number(url.searchParams.get('limit') ?? '500');

      let filtered = entries;
      if (since) {
        filtered = filtered.filter((e) => e.createdAt > since);
      }

      let startIndex = 0;
      if (cursorId) {
        const idx = filtered.findIndex((e) => e.attachmentId === cursorId);
        startIndex = idx >= 0 ? idx + 1 : 0;
      }

      const page = filtered.slice(startIndex, startIndex + limit);
      const nextCursor =
        startIndex + limit < filtered.length ? (page[page.length - 1]?.attachmentId ?? null) : null;
      const maxCreatedAt = filtered.length > 0 ? filtered[filtered.length - 1].createdAt : null;

      const body = JSON.stringify({
        data: page.map((e) => ({
          attachmentId: e.attachmentId,
          relativePath: e.relativePath,
          fileType: e.fileType,
          sizeBytes: e.content.length,
          sha256: e.sha256,
          createdAt: e.createdAt,
          receivedAt: e.createdAt,
          senderEmail: 'test@example.com',
          missing: false,
        })),
        meta: {
          nextCursor,
          maxCreatedAt,
          totalFiles: filtered.length,
          totalBytes: filtered.reduce((acc, e) => acc + e.content.length, 0),
          missingFiles: 0,
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    const downloadMatch = url.pathname.match(/^\/attachments\/([^/]+)\/download$/);
    if (downloadMatch) {
      const id = downloadMatch[1];
      downloadRequests[id] = (downloadRequests[id] ?? 0) + 1;
      const entry = entries.find((e) => e.attachmentId === id);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ATTACHMENT_NOT_FOUND', message: 'no encontrado' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': entry.content.length,
      });
      res.end(entry.content);
      return;
    }

    if (url.pathname === '/export/archive') {
      archiveState.count++;
      const since = url.searchParams.get('since');
      const month = url.searchParams.get('month');

      let filtered = entries;
      if (since) filtered = filtered.filter((e) => e.createdAt > since);
      if (month) filtered = filtered.filter((e) => e.relativePath.split('/')[1] === month);

      const zip = buildZip(
        filtered.map((e) => ({ path: e.relativePath, content: e.archiveContent ?? e.content })),
      );
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
      });
      res.end(zip);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        downloadRequests,
        get archiveRequests() {
          return archiveState.count;
        },
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
