import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { createSeedClient, seedApiKey, seedTenant } from './helpers/tenant-fixtures';

const ACCOUNT_ID = randomUUID();
const FOLDER_NAME = 'export_e2e_ltsoft_us';

function fakeSha256(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0');
}

function bufferResponse() {
  return (res: request.Response, callback: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  };
}

describe('Export (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let storageRoot: string;
  let apiKey: string;

  const julyAttachmentIds: string[] = [];
  let augustAttachmentId: string;
  let missingAttachmentId: string;
  let sinceCutoff: Date;
  let tenantSlug: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = createSeedClient();
    storageRoot = process.env.STORAGE_ROOT as string;
    await seedFixtures();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function writeRealFile(
    monthFolder: string,
    type: 'json' | 'pdf',
    filename: string,
    content: string,
  ): string {
    const dir = join(storageRoot, tenantSlug, FOLDER_NAME, monthFolder, type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
    return `${tenantSlug}/${FOLDER_NAME}/${monthFolder}/${type}/${filename}`;
  }

  async function seedFixtures(): Promise<void> {
    const tenant = await seedTenant(prisma);
    tenantSlug = tenant.slug;
    apiKey = (await seedApiKey(prisma, tenant.id)).plainKey;
    const tenantId = tenant.id;

    await prisma.emailAccount.create({
      data: {
        id: ACCOUNT_ID,
        tenantId,
        alias: 'Cuenta Export E2E',
        email: 'export-e2e@ltsoft.us',
        folderName: FOLDER_NAME,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'export-e2e@ltsoft.us',
        imapPassEnc: 'aa==:bb==:cc==',
      },
    });

    // 6 adjuntos de julio con createdAt controlado; dos pares comparten timestamp exacto
    // (fuerza el desempate por id en la paginación por cursor).
    const baseTime = new Date('2026-07-01T00:00:00Z').getTime();
    const offsetsMs = [0, 0, 60_000, 60_000, 120_000, 180_000];
    sinceCutoff = new Date(baseTime + 60_000);

    for (let i = 0; i < offsetsMs.length; i++) {
      const email = await prisma.processedEmail.create({
        data: {
          tenantId,
          accountId: ACCOUNT_ID,
          messageId: `msg-julio-${i}@e2e`,
          uid: i + 1,
          subject: `Correo julio ${i}`,
          senderName: 'Proveedor',
          senderEmail: 'proveedor@dte.com',
          recipients: ['export-e2e@ltsoft.us'],
          receivedAt: new Date('2026-07-10T12:00:00Z'),
          monthFolder: '2026-07',
          attachmentCount: 1,
          status: 'PROCESADO',
        },
      });
      const filename = `archivo_${i}.json`;
      const content = JSON.stringify({ i });
      const relativePath = writeRealFile('2026-07', 'json', filename, content);
      const attachment = await prisma.attachment.create({
        data: {
          tenantId,
          emailId: email.id,
          originalName: filename,
          storedName: filename,
          relativePath,
          fileType: 'JSON',
          mimeType: 'application/json',
          sizeBytes: Buffer.byteLength(content),
          sha256: fakeSha256(),
          createdAt: new Date(baseTime + offsetsMs[i]),
        },
      });
      julyAttachmentIds.push(attachment.id);
    }

    // un adjunto de agosto, para probar el filtro month
    const augustEmail = await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-agosto@e2e',
        uid: 100,
        subject: 'Correo agosto',
        senderName: 'Proveedor',
        senderEmail: 'proveedor@dte.com',
        recipients: ['export-e2e@ltsoft.us'],
        receivedAt: new Date('2026-08-05T12:00:00Z'),
        monthFolder: '2026-08',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    const augustContent = '%PDF-1.4 agosto';
    const augustRelativePath = writeRealFile('2026-08', 'pdf', 'agosto.pdf', augustContent);
    const augustAttachment = await prisma.attachment.create({
      data: {
        tenantId,
        emailId: augustEmail.id,
        originalName: 'agosto.pdf',
        storedName: 'agosto.pdf',
        relativePath: augustRelativePath,
        fileType: 'PDF',
        mimeType: 'application/pdf',
        sizeBytes: Buffer.byteLength(augustContent),
        sha256: fakeSha256(),
        createdAt: new Date('2026-08-05T12:00:00Z'),
      },
    });
    augustAttachmentId = augustAttachment.id;

    // un adjunto cuyo archivo se borra del disco DESPUÉS de registrarlo en BD (simula pérdida real)
    const missingEmail = await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-perdido@e2e',
        uid: 200,
        subject: 'Correo con archivo perdido',
        senderName: 'Proveedor',
        senderEmail: 'proveedor@dte.com',
        recipients: ['export-e2e@ltsoft.us'],
        receivedAt: new Date('2026-07-12T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    const missingRelativePath = writeRealFile('2026-07', 'json', 'perdido.json', '{}');
    const missingAbsolutePath = join(storageRoot, missingRelativePath);
    const missingAttachment = await prisma.attachment.create({
      data: {
        tenantId,
        emailId: missingEmail.id,
        originalName: 'perdido.json',
        storedName: 'perdido.json',
        relativePath: missingRelativePath,
        fileType: 'JSON',
        mimeType: 'application/json',
        sizeBytes: 2,
        sha256: fakeSha256(),
        createdAt: new Date(baseTime + 240_000),
      },
    });
    missingAttachmentId = missingAttachment.id;
    unlinkSync(missingAbsolutePath);
  }

  describe('GET /export/manifest', () => {
    it('since filtra exacto: solo createdAt estrictamente mayor al cursor de fecha', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/export/manifest')
        .query({ accountId: ACCOUNT_ID, since: sinceCutoff.toISOString(), limit: 100 })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.map((e: { attachmentId: string }) => e.attachmentId);
      expect(ids).not.toContain(julyAttachmentIds[0]); // offset 0
      expect(ids).not.toContain(julyAttachmentIds[1]); // offset 0
      expect(ids).not.toContain(julyAttachmentIds[2]); // offset 60_000 === cutoff, no es "mayor"
      expect(ids).not.toContain(julyAttachmentIds[3]); // offset 60_000 === cutoff
      expect(ids).toContain(julyAttachmentIds[4]); // offset 120_000
      expect(ids).toContain(julyAttachmentIds[5]); // offset 180_000
    });

    it('filtra por month: solo trae adjuntos de ese mes', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/export/manifest')
        .query({ accountId: ACCOUNT_ID, month: '2026-08', limit: 100 })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].attachmentId).toBe(augustAttachmentId);
    });

    it('pagina de forma estable: sin huecos ni ids repetidos entre páginas', async () => {
      const seen = new Set<string>();
      let cursorId: string | undefined;
      let pages = 0;

      do {
        const res = await request(app.getHttpServer())
          .get('/api/v1/export/manifest')
          .query({
            accountId: ACCOUNT_ID,
            month: '2026-07',
            limit: 2,
            ...(cursorId ? { cursorId } : {}),
          })
          .set('X-Api-Key', apiKey);

        expect(res.status).toBe(200);
        for (const entry of res.body.data as { attachmentId: string }[]) {
          expect(seen.has(entry.attachmentId)).toBe(false);
          seen.add(entry.attachmentId);
        }
        cursorId = res.body.meta.nextCursor;
        pages++;
        expect(pages).toBeLessThan(20);
      } while (cursorId);

      // 6 de julio + 1 perdido = 7 adjuntos, sin huecos
      expect(seen.size).toBe(7);
      for (const id of julyAttachmentIds) expect(seen.has(id)).toBe(true);
      expect(seen.has(missingAttachmentId)).toBe(true);
    });

    it('un archivo borrado del disco aparece missing:true sin romper la respuesta', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/export/manifest')
        .query({ accountId: ACCOUNT_ID, month: '2026-07', limit: 100 })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      const entry = res.body.data.find(
        (e: { attachmentId: string }) => e.attachmentId === missingAttachmentId,
      );
      expect(entry.missing).toBe(true);
      expect(res.body.meta.missingFiles).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /export/archive', () => {
    it('el ZIP omite el archivo faltante sin romperse y lo deja en manifest.json con missing:true', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/export/archive')
        .query({ accountId: ACCOUNT_ID, month: '2026-07' })
        .set('X-Api-Key', apiKey)
        .buffer(true)
        .parse(bufferResponse());

      expect(res.status).toBe(200);
      const zip = new AdmZip(res.body as Buffer);
      const entries = zip.getEntries();

      const manifestEntry = entries.find((e) => e.entryName === 'manifest.json');
      expect(manifestEntry).toBeDefined();
      const manifestJson = JSON.parse(manifestEntry!.getData().toString('utf8'));
      const missingInManifest = manifestJson.find(
        (m: { attachmentId: string }) => m.attachmentId === missingAttachmentId,
      );
      expect(missingInManifest.missing).toBe(true);

      const missingZipEntry = entries.find((e) => e.entryName.endsWith('perdido.json'));
      expect(missingZipEntry).toBeUndefined();

      const presentEntry = entries.find(
        (e) => e.entryName === `${tenantSlug}/${FOLDER_NAME}/2026-07/json/archivo_0.json`,
      );
      expect(presentEntry).toBeDefined();
      expect(JSON.parse(presentEntry!.getData().toString('utf8'))).toEqual({ i: 0 });
    });

    it('preserva la estructura folderName/YYYY-MM/json|pdf/archivo para todos los tipos', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/export/archive')
        .query({ accountId: ACCOUNT_ID })
        .set('X-Api-Key', apiKey)
        .buffer(true)
        .parse(bufferResponse());

      expect(res.status).toBe(200);
      const zip = new AdmZip(res.body as Buffer);
      const names = zip.getEntries().map((e) => e.entryName);

      expect(names).toContain('manifest.json');
      expect(names).toContain(`${tenantSlug}/${FOLDER_NAME}/2026-07/json/archivo_0.json`);
      expect(names).toContain(`${tenantSlug}/${FOLDER_NAME}/2026-08/pdf/agosto.pdf`);
    });
  });
});
