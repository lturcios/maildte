import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { createSeedClient, seedApiKey, seedTenant, seedUser } from './helpers/tenant-fixtures';

/** Checklist de aislamiento COMPLETO de la skill tenancy (sembrando tenants A y B). */
describe('Aislamiento multi-tenant (e2e)', () => {
  let app: INestApplication;
  let seedPrisma: PrismaClient;

  let tenantA: { id: string; slug: string };
  let tenantB: { id: string; slug: string };
  let tokenA: string;
  let apiKeyA: string;
  let accountAId: string;
  let accountBId: string;
  let emailInTenantBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    seedPrisma = createSeedClient();

    tenantA = await seedTenant(seedPrisma);
    tenantB = await seedTenant(seedPrisma);
    const adminA = await seedUser(seedPrisma, tenantA.id, 'ADMIN');
    await seedUser(seedPrisma, tenantB.id, 'ADMIN');

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminA.email, password: adminA.password });
    tokenA = loginRes.body.data.accessToken as string;
    apiKeyA = (await seedApiKey(seedPrisma, tenantA.id)).plainKey;

    const accountA = await seedPrisma.emailAccount.create({
      data: {
        tenantId: tenantA.id,
        alias: 'Cuenta A',
        email: 'cuenta-a@test.local',
        folderName: `${tenantA.slug}_cuenta_a`,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'cuenta-a@test.local',
        imapPassEnc: 'aa==:bb==:cc==',
      },
    });
    accountAId = accountA.id;

    await seedPrisma.processedEmail.create({
      data: {
        tenantId: tenantA.id,
        accountId: accountAId,
        messageId: 'msg-tenant-a@test',
        uid: 1,
        subject: 'Correo del tenant A',
        senderEmail: 'proveedor@dte.com',
        recipients: ['cuenta-a@test.local'],
        receivedAt: new Date('2026-07-15T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 0,
        status: 'SIN_ADJUNTOS',
      },
    });

    const accountB = await seedPrisma.emailAccount.create({
      data: {
        tenantId: tenantB.id,
        alias: 'Cuenta B',
        email: 'cuenta-b@test.local',
        folderName: `${tenantB.slug}_cuenta_b`,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'cuenta-b@test.local',
        imapPassEnc: 'aa==:bb==:cc==',
      },
    });
    accountBId = accountB.id;
    const emailInTenantB = await seedPrisma.processedEmail.create({
      data: {
        tenantId: tenantB.id,
        accountId: accountB.id,
        messageId: 'msg-tenant-b@test',
        uid: 1,
        subject: 'Correo del tenant B — jamás debería verlo A',
        senderEmail: 'proveedor@dte.com',
        recipients: ['cuenta-b@test.local'],
        receivedAt: new Date('2026-07-16T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 0,
        status: 'SIN_ADJUNTOS',
      },
    });
    emailInTenantBId = emailInTenantB.id;
  });

  afterAll(async () => {
    await app.close();
    await seedPrisma.$disconnect();
  });

  it('GET /emails/:id de un correo de otro tenant -> 404 (no 403: no revela existencia)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/emails/${emailInTenantBId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EMAIL_NOT_FOUND');
  });

  it('GET /emails con auth del tenant A nunca incluye filas del tenant B', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/emails')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const subjects: string[] = res.body.data.map((e: { subject: string }) => e.subject);
    expect(subjects).toContain('Correo del tenant A');
    expect(subjects).not.toContain('Correo del tenant B — jamás debería verlo A');
    expect(res.body.data.every((e: { id: string }) => e.id !== emailInTenantBId)).toBe(true);
  });

  it('API key del tenant A + accountId del tenant B en GET /export/manifest -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/export/manifest')
      .query({ accountId: accountBId })
      .set('X-Api-Key', apiKeyA);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('relativePath manipulado al slug de OTRO tenant -> 400 (no 404: el registro sí es de A)', async () => {
    const emailA = await seedPrisma.processedEmail.create({
      data: {
        tenantId: tenantA.id,
        accountId: accountAId,
        messageId: 'msg-tenant-a-traversal@test',
        uid: 99,
        subject: 'Adjunto con path manipulado',
        senderEmail: 'proveedor@dte.com',
        recipients: ['cuenta-a@test.local'],
        receivedAt: new Date('2026-07-17T12:00:00Z'),
        monthFolder: '2026-07',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });
    // El registro pertenece legítimamente al tenant A (pasa el chequeo de ownership),
    // pero su relativePath fue adulterado para apuntar bajo el slug del tenant B.
    const attachment = await seedPrisma.attachment.create({
      data: {
        tenantId: tenantA.id,
        emailId: emailA.id,
        originalName: 'secreto.json',
        storedName: 'secreto.json',
        relativePath: `${tenantB.slug}/cuenta_b/2026-07/json/secreto.json`,
        fileType: 'JSON',
        mimeType: 'application/json',
        sizeBytes: 10,
        sha256: 'd'.repeat(64),
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/attachments/${attachment.id}/download`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_STORAGE_PATH');
  });

  it('tenant SUSPENDIDO: API de negocio retorna 403 TENANT_SUSPENDED', async () => {
    const tenantC = await seedTenant(seedPrisma, { status: 'SUSPENDIDO' });
    const adminC = await seedUser(seedPrisma, tenantC.id, 'ADMIN');

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminC.email, password: adminC.password });

    // El login en sí ya pasa por assertTenantActiveFor -> 403 antes de emitir tokens.
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error).toBe('TENANT_SUSPENDED');
  });

  it('withTenant(A) ve solo filas de A, nunca de B', async () => {
    // A propósito el rol restringido (APP_DATABASE_URL), no el owner de seedPrisma: el owner
    // es superusuario y bypasea RLS siempre, así que probar esto con seedPrisma "pasaría"
    // aunque RLS no funcionara — el mismo hallazgo que motivó separar los roles.
    const restrictedClient = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
    try {
      const rows = await restrictedClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA.id}, true)`;
        return tx.processedEmail.findMany({ select: { id: true, tenantId: true } });
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === tenantA.id)).toBe(true);
      expect(rows.some((r) => r.id === emailInTenantBId)).toBe(false);
    } finally {
      await restrictedClient.$disconnect();
    }
  });

  it('query directa sin set_config de tenant contra una tabla con RLS -> 0 filas', async () => {
    // Cliente aparte conectado con el rol restringido de la app (no el owner/superusuario):
    // sin SET LOCAL app.tenant_id, la policy nunca matchea nada.
    const restrictedClient = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
    try {
      const count = await restrictedClient.processedEmail.count();
      expect(count).toBe(0);
    } finally {
      await restrictedClient.$disconnect();
    }
  });
});
