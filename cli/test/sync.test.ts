import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localRelativePath, runSync } from '../src/commands/sync';
import { statePath } from '../src/lib/state';
import { CliConfig } from '../src/lib/types';
import { startTestServer, TestManifestEntry, TestServer } from './test-server';
import { captureConsole, captureExitCode, makeTempCwd, sha256, writeTestConfig } from './helpers';

const ACCOUNT_ID = randomUUID();
const DEST_DIR = './data';

function baseConfig(apiUrl: string): CliConfig {
  return {
    apiUrl,
    apiKey: 'test-key',
    destDir: DEST_DIR,
    accounts: [{ id: ACCOUNT_ID, alias: 'Cuenta Test', email: 'cuenta@test.com' }],
  };
}

test('sync incremental: avanza el cursor solo si todo el lote verificó', async () => {
  const cwd = makeTempCwd();
  const content1 = Buffer.from('contenido uno');
  const content2 = Buffer.from('contenido dos');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/doc1.pdf',
      content: content1,
      sha256: sha256(content1),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/doc2.pdf',
      content: content2,
      sha256: sha256(content2),
      createdAt: '2026-07-02T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync([], { cwd }));
    console_.restore();

    assert.equal(exitCode, 0);
    const state = JSON.parse(readFileSync(statePath(join(cwd, DEST_DIR)), 'utf8')) as Record<
      string,
      { cursor: string | null }
    >;
    assert.equal(state[ACCOUNT_ID].cursor, '2026-07-02T00:00:00.000Z');
    assert.ok(existsSync(join(cwd, DEST_DIR, localRelativePath(entries[0].relativePath, true))));
    assert.ok(existsSync(join(cwd, DEST_DIR, localRelativePath(entries[1].relativePath, true))));
  } finally {
    await server.close();
  }
});

test('sync incremental: NO avanza el cursor si algún archivo del lote falla', async () => {
  const cwd = makeTempCwd();
  const goodContent = Buffer.from('archivo bueno');
  const badContent = Buffer.from('archivo malo');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/bueno.pdf',
      content: goodContent,
      sha256: sha256(goodContent),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/malo.pdf',
      content: badContent,
      // hash incorrecto a propósito: simula corrupción/adulteración en tránsito
      sha256: 'a'.repeat(64),
      createdAt: '2026-07-02T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync([], { cwd }));
    console_.restore();

    assert.equal(exitCode, 1);
    assert.equal(existsSync(statePath(join(cwd, DEST_DIR))), false);
    assert.ok(console_.errors.some((line) => line.includes('malo.pdf')));
  } finally {
    await server.close();
  }
});

test('sync --all: salta archivos existentes con hash válido y no los vuelve a descargar', async () => {
  // --all siempre usa ZIP por mes (regla explícita del addendum RF-07), así que el archivo
  // "ya existente" debe quedar afuera del lote pendiente ANTES de armar el ZIP. Para probarlo
  // sin ambigüedad, el ZIP servido trae para ese archivo bytes "trampa" que nunca deberían
  // escribirse: si el cliente lo descarta correctamente por ya tenerlo con hash válido, el
  // contenido original en disco queda intacto.
  const cwd = makeTempCwd();
  const existingContent = Buffer.from('ya lo tengo');
  const trapContent = Buffer.from('esto NUNCA debería escribirse');
  const newContent = Buffer.from('archivo nuevo');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'acme/cuenta_test/2026-07/pdf/existente.pdf',
      content: existingContent,
      archiveContent: trapContent,
      sha256: sha256(existingContent),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
    {
      attachmentId: randomUUID(),
      relativePath: 'acme/cuenta_test/2026-07/pdf/nuevo.pdf',
      content: newContent,
      sha256: sha256(newContent),
      createdAt: '2026-07-02T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const existingPath = join(cwd, DEST_DIR, localRelativePath(entries[0].relativePath, true));
    mkdirSync(join(existingPath, '..'), { recursive: true });
    writeFileSync(existingPath, existingContent);

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync(['--all'], { cwd }));
    console_.restore();

    assert.equal(exitCode, 0);
    assert.equal(server.downloadRequests[entries[0].attachmentId] ?? 0, 0);
    assert.ok(server.archiveRequests >= 1);
    assert.equal(readFileSync(existingPath).toString(), existingContent.toString());
    assert.equal(
      readFileSync(
        join(cwd, DEST_DIR, localRelativePath(entries[1].relativePath, true)),
      ).toString(),
      newContent.toString(),
    );
  } finally {
    await server.close();
  }
});

test('sync: hash corrupto reintenta hasta 3 veces y lo reporta como fallo', async () => {
  const cwd = makeTempCwd();
  const content = Buffer.from('contenido con hash adulterado');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/corrupto.pdf',
      content,
      sha256: 'f'.repeat(64), // nunca va a coincidir con el hash real del contenido
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync([], { cwd }));
    console_.restore();

    assert.equal(exitCode, 1);
    assert.equal(server.downloadRequests[entries[0].attachmentId], 3);
    assert.ok(
      console_.errors.some((line) => line.includes('corrupto.pdf') && line.includes('3 intentos')),
    );
  } finally {
    await server.close();
  }
});

test('sync --dry-run: no escribe archivos ni actualiza el estado', async () => {
  const cwd = makeTempCwd();
  const content = Buffer.from('no debería escribirse');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'cuenta_test/2026-07/pdf/pendiente.pdf',
      content,
      sha256: sha256(content),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync(['--dry-run'], { cwd }));
    console_.restore();

    assert.equal(exitCode, 0);
    assert.equal(existsSync(join(cwd, DEST_DIR, entries[0].relativePath)), false);
    assert.equal(existsSync(statePath(join(cwd, DEST_DIR))), false);
    assert.equal(server.downloadRequests[entries[0].attachmentId] ?? 0, 0);
  } finally {
    await server.close();
  }
});

test('sync: por default omite el primer segmento (tenantSlug) del relativePath al escribir localmente', async () => {
  const cwd = makeTempCwd();
  const content = Buffer.from('contenido del tenant');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'acme-corp/cuenta_test/2026-07/pdf/factura.pdf',
      content,
      sha256: sha256(content),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() => runSync([], { cwd }));
    console_.restore();

    assert.equal(exitCode, 0);
    // sin el slug "acme-corp" como carpeta raíz local
    assert.ok(existsSync(join(cwd, DEST_DIR, 'cuenta_test/2026-07/pdf/factura.pdf')));
    assert.equal(existsSync(join(cwd, DEST_DIR, 'acme-corp')), false);
  } finally {
    await server.close();
  }
});

test('sync --no-strip-tenant-prefix: conserva el relativePath completo del servidor', async () => {
  const cwd = makeTempCwd();
  const content = Buffer.from('contenido del tenant');
  const entries: TestManifestEntry[] = [
    {
      attachmentId: randomUUID(),
      relativePath: 'acme-corp/cuenta_test/2026-07/pdf/factura.pdf',
      content,
      sha256: sha256(content),
      createdAt: '2026-07-01T00:00:00.000Z',
      fileType: 'PDF',
    },
  ];
  const server: TestServer = await startTestServer(entries);
  try {
    writeTestConfig(cwd, baseConfig(server.url));

    const console_ = captureConsole();
    const exitCode = await captureExitCode(() =>
      runSync(['--no-strip-tenant-prefix'], { cwd }),
    );
    console_.restore();

    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(cwd, DEST_DIR, 'acme-corp/cuenta_test/2026-07/pdf/factura.pdf')));
  } finally {
    await server.close();
  }
});
