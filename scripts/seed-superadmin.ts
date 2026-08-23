/**
 * Semilla idempotente del usuario SUPERADMIN inicial (LTSOFT).
 *
 * Uso:
 *   SUPERADMIN_EMAIL=admin@ltsoft.us SUPERADMIN_PASSWORD=... pnpm run seed:superadmin
 *
 * Conecta con APP_DATABASE_URL (rol restringido, no el owner/superusuario de las
 * migraciones): la fila SUPERADMIN tiene tenantId NULL y la policy de RLS de `users`
 * permite escribir esas filas específicamente cuando NO hay ningún tenant en contexto
 * (ver comentario en la migración multi_tenancy) — este script nunca llama withTenant,
 * así que cumple esa condición sin necesitar el rol privilegiado.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

async function main(): Promise<void> {
  const email = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;
  const name = process.env.SUPERADMIN_NAME ?? 'Superadmin';

  if (!email || !password) {
    console.error(
      'Faltan variables de entorno: SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD son obligatorias.',
    );
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error('SUPERADMIN_PASSWORD debe tener al menos 8 caracteres.');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.APP_DATABASE_URL;
  if (!databaseUrl) {
    console.error('Falta la variable de entorno APP_DATABASE_URL.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      if (existing.role !== 'SUPERADMIN' || existing.tenantId !== null) {
        console.error(
          `Ya existe un usuario con ${email} pero no es SUPERADMIN sin tenant (role=${existing.role}, tenantId=${existing.tenantId}). No se modifica: resolvé el conflicto a mano.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(`El SUPERADMIN ${email} ya existe (id=${existing.id}). Nada que hacer.`);
      return;
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const created = await prisma.user.create({
      data: { email, name, passwordHash, role: 'SUPERADMIN', tenantId: null },
      select: { id: true, email: true },
    });

    console.log(`SUPERADMIN creado: ${created.email} (id=${created.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Error inesperado al sembrar el SUPERADMIN:', err);
  process.exitCode = 1;
});
