import { PrismaClient, Role } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as argon2 from 'argon2';

/**
 * Cliente Prisma crudo para sembrar fixtures de test conectado con DATABASE_URL
 * (el rol owner/superusuario que corre las migraciones). A propósito NO es el mismo
 * rol que usa la app bajo test (PrismaService usa APP_DATABASE_URL, el rol
 * restringido): sembrar fixtures es una operación administrativa análoga a una
 * migración (skill tenancy, regla 9), y como el owner es superusuario bypasea RLS,
 * lo que permite insertar filas de cualquier tenant sin depender de withTenant.
 * El comportamiento bajo test (requests HTTP contra la app) sí pasa por RLS real.
 */
export function createSeedClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
}

export interface SeededTenant {
  id: string;
  slug: string;
}

export async function seedTenant(
  prisma: PrismaClient,
  overrides: Partial<{ name: string; slug: string; status: 'ACTIVO' | 'SUSPENDIDO' }> = {},
): Promise<SeededTenant> {
  const slug = overrides.slug ?? `tenant-${randomUUID().slice(0, 8)}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: overrides.name ?? `Tenant ${slug}`,
      slug,
      status: overrides.status ?? 'ACTIVO',
    },
  });
  return { id: tenant.id, slug: tenant.slug };
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

export async function seedUser(
  prisma: PrismaClient,
  tenantId: string | null,
  role: Role,
  overrides: Partial<{ email: string; name: string; password: string; active: boolean }> = {},
): Promise<SeededUser> {
  const email = overrides.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.local`;
  const password = overrides.password ?? 'contraseña-segura-123';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.user.create({
    data: {
      tenantId,
      email,
      name: overrides.name ?? 'Usuario de Test',
      passwordHash,
      role,
      active: overrides.active ?? true,
    },
  });
  return { id: user.id, email: user.email, password };
}

export interface SeededApiKey {
  id: string;
  plainKey: string;
}

export async function seedApiKey(
  prisma: PrismaClient,
  tenantId: string,
  overrides: Partial<{ name: string; revoked: boolean }> = {},
): Promise<SeededApiKey> {
  const plainKey = `mdte_test_${randomBytes(24).toString('base64url')}`;
  const keyHash = createHash('sha256').update(plainKey).digest('hex');
  const apiKey = await prisma.tenantApiKey.create({
    data: {
      tenantId,
      name: overrides.name ?? 'Key de test',
      keyHash,
      revokedAt: overrides.revoked ? new Date() : null,
    },
  });
  return { id: apiKey.id, plainKey };
}
