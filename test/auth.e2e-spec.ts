import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { createSeedClient, seedApiKey, seedTenant, seedUser } from './helpers/tenant-fixtures';
import { PrismaClient } from '@prisma/client';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let seedPrisma: PrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    seedPrisma = createSeedClient();
  });

  afterAll(async () => {
    await app.close();
    await seedPrisma.$disconnect();
  });

  describe('POST /auth/login', () => {
    it('credenciales válidas -> 200 con accessToken y refreshToken', async () => {
      const tenant = await seedTenant(seedPrisma);
      const admin = await seedUser(seedPrisma, tenant.id, 'ADMIN');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password });

      expect(res.status).toBe(200);
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
    });

    it('contraseña incorrecta -> 401 INVALID_CREDENTIALS', async () => {
      const tenant = await seedTenant(seedPrisma);
      const admin = await seedUser(seedPrisma, tenant.id, 'ADMIN');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: 'esta-no-es-la-clave' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });

    it('email inexistente -> 401 INVALID_CREDENTIALS (mismo error que contraseña incorrecta)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'no-existe@test.local', password: 'cualquier-clave-123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rota el refresh token: el nuevo es distinto del original y funciona', async () => {
      const tenant = await seedTenant(seedPrisma);
      const admin = await seedUser(seedPrisma, tenant.id, 'ADMIN');

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password });
      const originalRefreshToken = loginRes.body.data.refreshToken as string;

      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefreshToken });

      expect(refreshRes.status).toBe(200);
      const newRefreshToken = refreshRes.body.data.refreshToken as string;
      expect(newRefreshToken).not.toBe(originalRefreshToken);
    });

    it('reusar un refresh token ya rotado lo rechaza y revoca toda la sesión (detección de robo)', async () => {
      const tenant = await seedTenant(seedPrisma);
      const admin = await seedUser(seedPrisma, tenant.id, 'ADMIN');

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password });
      const originalRefreshToken = loginRes.body.data.refreshToken as string;

      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefreshToken });
      const newRefreshToken = refreshRes.body.data.refreshToken as string;

      // El refresh token original ya rotó: reusarlo debe fallar.
      const reuseRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefreshToken });
      expect(reuseRes.status).toBe(401);

      // Reusar un token ya rotado es la señal clásica de robo: como medida de
      // seguridad, invalida TODA la sesión — el token nuevo (legítimo) también
      // deja de servir, forzando un login nuevo.
      const afterReuseRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: newRefreshToken });
      expect(afterReuseRes.status).toBe(401);
    });

    it('refresh token inválido -> 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'esto-no-es-un-jwt-valido' });
      expect(res.status).toBe(401);
    });
  });

  describe('Autenticación con TenantApiKey', () => {
    it('API key revocada -> 401 INVALID_API_KEY', async () => {
      const tenant = await seedTenant(seedPrisma);
      const revokedKey = await seedApiKey(seedPrisma, tenant.id, { revoked: true });

      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .set('X-Api-Key', revokedKey.plainKey);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_API_KEY');
    });

    it('API key válida -> 200', async () => {
      const tenant = await seedTenant(seedPrisma);
      const activeKey = await seedApiKey(seedPrisma, tenant.id);

      const res = await request(app.getHttpServer())
        .get('/api/v1/emails')
        .set('X-Api-Key', activeKey.plainKey);

      expect(res.status).toBe(200);
    });
  });

  describe('Autorización por rol', () => {
    it('MIEMBRO no puede crear cuentas de correo -> 403', async () => {
      const tenant = await seedTenant(seedPrisma);
      const miembro = await seedUser(seedPrisma, tenant.id, 'MIEMBRO');

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: miembro.email, password: miembro.password });
      const accessToken = loginRes.body.data.accessToken as string;

      const res = await request(app.getHttpServer())
        .post('/api/v1/accounts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          alias: 'Cuenta que no debería crearse',
          email: 'intento@test.local',
          imapHost: 'imap.example.com',
          imapPort: 993,
          imapSecure: true,
          imapUser: 'intento@test.local',
          imapPassword: 'clave-imap',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_ROLE');
    });

    it('ADMIN de tenant (no SUPERADMIN) contra /admin/* -> 403', async () => {
      const tenant = await seedTenant(seedPrisma);
      const admin = await seedUser(seedPrisma, tenant.id, 'ADMIN');

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password });
      const accessToken = loginRes.body.data.accessToken as string;

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/tenants')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(403);
    });
  });
});
