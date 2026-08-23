import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { createSeedClient, seedApiKey, seedTenant, seedUser } from './helpers/tenant-fixtures';

// UUID v4 real (no un patrón repetido): @IsUUID() de class-validator exige
// nibbles de versión/variante válidos, no solo la forma 8-4-4-4-12.
const ACCOUNT_ID = randomUUID();
const REAL_FILE_NAME = 'factura_núñez.pdf';

describe('Emails / Attachments / SyncLogs / Stats (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let apiKey: string;
  let downloadableAttachmentId: string;
  let missingFileAttachmentId: string;
  let traversalAttachmentId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Fixtures sembradas con el rol owner (bypasea RLS): la app bajo test sigue usando
    // su propio rol restringido en cada request real, así que las aserciones siguen
    // probando el comportamiento real de la API, no un atajo del test.
    prisma = createSeedClient();
    await seedFixtures();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    rmSync(process.env.STORAGE_ROOT as string, { recursive: true, force: true });
  });

  async function seedFixtures(): Promise<void> {
    const tenant = await seedTenant(prisma);
    await seedUser(prisma, tenant.id, 'ADMIN');
    apiKey = (await seedApiKey(prisma, tenant.id)).plainKey;

    await prisma.emailAccount.create({
      data: {
        id: ACCOUNT_ID,
        tenantId: tenant.id,
        alias: 'Cuenta E2E',
        email: 'e2e@ltsoft.us',
        folderName: 'e2e_ltsoft_us',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'e2e@ltsoft.us',
        imapPassEnc: 'aa==:bb==:cc==',
      },
    });
    const tenantId = tenant.id;

    const storageDir = join(
      process.env.STORAGE_ROOT as string,
      tenant.slug,
      'e2e_ltsoft_us',
      '2026-07',
      'pdf',
    );
    mkdirSync(storageDir, { recursive: true });
    const realFileContent = '%PDF-1.4 contenido de prueba';
    writeFileSync(join(storageDir, REAL_FILE_NAME), realFileContent);
    const realFileSizeBytes = Buffer.byteLength(realFileContent);

    const emailWithAttachment = await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-con-adjunto@e2e',
        uid: 1,
        subject: 'Factura de julio',
        senderName: 'Proveedor Uno',
        senderEmail: 'proveedor.uno@dte.com',
        recipients: ['e2e@ltsoft.us'],
        receivedAt: new Date('2026-07-15T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    downloadableAttachmentId = (
      await prisma.attachment.create({
        data: {
          tenantId,
          emailId: emailWithAttachment.id,
          originalName: REAL_FILE_NAME,
          storedName: REAL_FILE_NAME,
          relativePath: `${tenant.slug}/e2e_ltsoft_us/2026-07/pdf/${REAL_FILE_NAME}`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sizeBytes: realFileSizeBytes,
          sha256: 'a'.repeat(64),
        },
      })
    ).id;

    await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-sin-adjunto@e2e',
        uid: 2,
        subject: 'Aviso',
        senderName: 'Otro Remitente',
        senderEmail: 'notificaciones@otro.com',
        recipients: ['e2e@ltsoft.us'],
        receivedAt: new Date('2026-07-20T09:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 0,
        status: 'SIN_ADJUNTOS',
      },
    });

    await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-fuera-de-rango@e2e',
        uid: 3,
        subject: 'Factura de junio',
        senderName: 'Proveedor Uno',
        senderEmail: 'proveedor.uno@dte.com',
        recipients: ['e2e@ltsoft.us'],
        receivedAt: new Date('2026-06-10T12:00:00Z'),
        monthFolder: '2026-06',
        attachmentCount: 0,
        status: 'SIN_ADJUNTOS',
      },
    });

    const emailMissingFile = await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-archivo-perdido@e2e',
        uid: 4,
        subject: 'Adjunto perdido',
        senderName: 'Proveedor Dos',
        senderEmail: 'proveedor.dos@dte.com',
        recipients: ['e2e@ltsoft.us'],
        receivedAt: new Date('2026-07-18T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    missingFileAttachmentId = (
      await prisma.attachment.create({
        data: {
          tenantId,
          emailId: emailMissingFile.id,
          originalName: 'no-existe.json',
          storedName: 'no-existe.json',
          relativePath: `${tenant.slug}/e2e_ltsoft_us/2026-07/json/no-existe.json`,
          fileType: 'JSON',
          mimeType: 'application/json',
          sizeBytes: 10,
          sha256: 'b'.repeat(64),
        },
      })
    ).id;

    const emailTraversal = await prisma.processedEmail.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        messageId: 'msg-traversal@e2e',
        uid: 5,
        subject: 'Intento de traversal',
        senderName: 'Malicioso',
        senderEmail: 'malicioso@x.com',
        recipients: ['e2e@ltsoft.us'],
        receivedAt: new Date('2026-07-19T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    traversalAttachmentId = (
      await prisma.attachment.create({
        data: {
          tenantId,
          emailId: emailTraversal.id,
          originalName: 'secreto.json',
          storedName: 'secreto.json',
          relativePath: '../../../../etc/passwd',
          fileType: 'JSON',
          mimeType: 'application/json',
          sizeBytes: 10,
          sha256: 'c'.repeat(64),
        },
      })
    ).id;

    await prisma.syncLog.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID,
        status: 'ERROR',
        errorDetail: 'Fallo de prueba',
        finishedAt: new Date(),
      },
    });
  }

  describe('GET /emails', () => {
    it('sin X-Api-Key -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/emails');
      expect(res.status).toBe(401);
    });

    it('filtra por accountId + rango de fechas + sender combinados, con meta.total exacto', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .query({
          accountId: ACCOUNT_ID,
          from: '2026-07-01T00:00:00Z',
          to: '2026-07-31T23:59:59Z',
          sender: 'proveedor.uno',
        })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 50, total: 1 });
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].subject).toBe('Factura de julio');
    });

    it('hasAttachments=true solo trae correos con adjuntos', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .query({ accountId: ACCOUNT_ID, hasAttachments: 'true' })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.data.every((e: { attachmentCount: number }) => e.attachmentCount > 0)).toBe(
        true,
      );
    });

    it('hasAttachments=false solo trae correos sin adjuntos', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .query({ accountId: ACCOUNT_ID, hasAttachments: 'false' })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(2);
      expect(res.body.data.every((e: { attachmentCount: number }) => e.attachmentCount === 0)).toBe(
        true,
      );
    });

    it('pagina correctamente (limit clamp y page fuera de rango)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .query({ accountId: ACCOUNT_ID, page: 99, limit: 2 })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta).toEqual({ page: 99, limit: 2, total: 5 });
    });
  });

  describe('GET /emails/:id', () => {
    it('404 si el correo no existe', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/emails/${randomUUID()}`)
        .set('X-Api-Key', apiKey);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('EMAIL_NOT_FOUND');
    });
  });

  describe('GET /attachments/:id/download', () => {
    it('descarga exitosa con Content-Disposition UTF-8 preservando tildes en el nombre original', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${downloadableAttachmentId}/download`)
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent(REAL_FILE_NAME)}`,
      );
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text).toContain(
        '%PDF-1.4',
      );
    });

    it('relativePath manipulado a traversal -> 400', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${traversalAttachmentId}/download`)
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_STORAGE_PATH');
    });

    it('adjunto registrado pero sin archivo en disco -> 410 FILE_MISSING', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${missingFileAttachmentId}/download`)
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(410);
      expect(res.body.error).toBe('FILE_MISSING');
    });

    it('404 si el adjunto no existe en BD', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${randomUUID()}/download`)
        .set('X-Api-Key', apiKey);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('ATTACHMENT_NOT_FOUND');
    });
  });

  describe('GET /sync-logs', () => {
    it('filtra por accountId y status', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/sync-logs')
        .query({ accountId: ACCOUNT_ID, status: 'ERROR' })
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].errorDetail).toBe('Fallo de prueba');
    });
  });

  describe('GET /stats/summary', () => {
    it('totales por cuenta y por cuenta+mes calculados en Postgres', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/stats/summary')
        .set('X-Api-Key', apiKey);

      expect(res.status).toBe(200);
      const accountStats = res.body.data.byAccount.find(
        (a: { accountId: string }) => a.accountId === ACCOUNT_ID,
      );
      expect(accountStats.totalEmails).toBe(5);
      expect(accountStats.filesCount).toBe(3);
      expect(accountStats.emailsByStatus.PROCESADO).toBe(3);
      expect(accountStats.emailsByStatus.SIN_ADJUNTOS).toBe(2);

      const monthStats = res.body.data.byAccountMonth.find(
        (m: { accountId: string; monthFolder: string }) =>
          m.accountId === ACCOUNT_ID && m.monthFolder === '2026-07',
      );
      expect(monthStats.emailsCount).toBe(4);

      expect(res.body.data.recentErrors).toHaveLength(1);
    });
  });

  describe('CU-03: consulta contable mensual de punta a punta', () => {
    it('lista PROCESADO del mes y descarga el adjunto real', async () => {
      const listRes = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .query({
          accountId: ACCOUNT_ID,
          from: '2026-07-01T00:00:00Z',
          to: '2026-07-31T23:59:59Z',
          status: 'PROCESADO',
        })
        .set('X-Api-Key', apiKey);

      expect(listRes.status).toBe(200);
      const factura = listRes.body.data.find(
        (e: { subject: string }) => e.subject === 'Factura de julio',
      );
      expect(factura).toBeDefined();
      expect(factura.senderEmail).toBe('proveedor.uno@dte.com');
      expect(factura.attachments).toHaveLength(1);

      const downloadRes = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${factura.attachments[0].id}/download`)
        .set('X-Api-Key', apiKey);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['content-disposition']).toContain(
        encodeURIComponent(REAL_FILE_NAME),
      );
    });
  });
});
