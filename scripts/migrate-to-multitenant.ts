/**
 * Migración de datos existentes a multi-tenancy (Addendum 08, sección 6).
 *
 * Rol de BD administrativo (DATABASE_URL, el owner/superusuario que corre las migraciones —
 * skill tenancy, regla 9): reasigna a un tenant real "ltsoft" los datos que la migración
 * `multi_tenancy` (Prompt 3.5a) dejó en el tenant placeholder "legacy-pre-tenancy" — ese
 * placeholder existe solo para satisfacer la constraint NOT NULL de tenantId en un entorno
 * que ya tenía filas antes de existir multi-tenancy; este script es el que las convierte en
 * un tenant real y utilizable. Además mueve los archivos en disco bajo STORAGE_ROOT/ltsoft/
 * y actualiza relativePath para que coincida (BD y disco consistentes).
 *
 * Uso:
 *   DATABASE_URL=... STORAGE_ROOT=... \
 *   SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... \
 *   MIGRATION_ADMIN_EMAIL=... MIGRATION_ADMIN_PASSWORD=... \
 *   pnpm run migrate:to-multitenant
 *
 * SUPERADMIN_* y MIGRATION_ADMIN_* son opcionales: si ya corriste `seed:superadmin` antes,
 * omitilas y este script solo hace el paso 3 (o ninguno de los dos, si tampoco das
 * MIGRATION_ADMIN_*) — cada paso detecta trabajo ya hecho y lo salta, así que correr este
 * script más de una vez es seguro.
 *
 * Reversible antes de confirmar: el único paso que toca archivos es un `rename` (paso 5),
 * atómico dentro del mismo filesystem y NO destructivo — mueve, no copia+borra. Si algo se
 * ve mal en la verificación final, se puede deshacer a mano renombrando
 * STORAGE_ROOT/ltsoft/{folderName} de vuelta a STORAGE_ROOT/{folderName} y revirtiendo el
 * UPDATE de relativePath (o restaurando desde el backup de BD previo a correr el script,
 * que siempre debería existir antes de una migración de este tipo).
 */
import { PrismaClient, Tenant } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, rename } from 'fs/promises';
import { dirname, join } from 'path';

const LEGACY_SLUG = 'legacy-pre-tenancy';
const LTSOFT_SLUG = process.env.LTSOFT_TENANT_SLUG ?? 'ltsoft';

async function ensureLtsoftTenant(prisma: PrismaClient): Promise<Tenant> {
  const existing = await prisma.tenant.findUnique({ where: { slug: LTSOFT_SLUG } });
  if (existing) {
    console.log(`Paso 1: tenant "${LTSOFT_SLUG}" ya existe (id=${existing.id}). Se reutiliza.`);
    return existing;
  }
  const created = await prisma.tenant.create({
    data: { name: 'LTSOFT', slug: LTSOFT_SLUG, maxAccounts: 999, maxStorageBytes: 5_368_709_120_000n },
  });
  console.log(`Paso 1: tenant "${LTSOFT_SLUG}" creado (id=${created.id}).`);
  return created;
}

async function ensureSuperadmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.log('Paso 2: SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD no provistos, se omite.');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Paso 2: usuario ${email} ya existe (id=${existing.id}). Se omite.`);
    return;
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const created = await prisma.user.create({
    data: {
      email,
      name: process.env.SUPERADMIN_NAME ?? 'Superadmin',
      passwordHash,
      role: 'SUPERADMIN',
      tenantId: null,
    },
  });
  console.log(`Paso 2: SUPERADMIN creado (${created.email}, id=${created.id}).`);
}

async function ensureLtsoftAdmin(prisma: PrismaClient, tenantId: string): Promise<void> {
  const email = process.env.MIGRATION_ADMIN_EMAIL;
  const password = process.env.MIGRATION_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('Paso 3: MIGRATION_ADMIN_EMAIL/MIGRATION_ADMIN_PASSWORD no provistos, se omite.');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Paso 3: usuario ${email} ya existe (id=${existing.id}). Se omite.`);
    return;
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const created = await prisma.user.create({
    data: {
      tenantId,
      email,
      name: process.env.MIGRATION_ADMIN_NAME ?? 'Administrador',
      passwordHash,
      role: 'ADMIN',
    },
  });
  console.log(`Paso 3: ADMIN de "${LTSOFT_SLUG}" creado (${created.email}, id=${created.id}).`);
}

/** Reasigna las 4 tablas de negocio del tenant placeholder a ltsoft en una única transacción. */
async function reassignTenantData(
  prisma: PrismaClient,
  ltsoftId: string,
): Promise<{ folderNames: string[] }> {
  const legacyTenant = await prisma.tenant.findUnique({ where: { slug: LEGACY_SLUG } });
  if (!legacyTenant) {
    console.log(`Paso 4: no existe el tenant placeholder "${LEGACY_SLUG}" — nada que reasignar.`);
    return { folderNames: [] };
  }
  if (legacyTenant.id === ltsoftId) {
    throw new Error('El tenant legacy y ltsoft no pueden ser el mismo (LTSOFT_TENANT_SLUG mal configurado).');
  }

  const legacyAccounts = await prisma.emailAccount.findMany({
    where: { tenantId: legacyTenant.id },
    select: { folderName: true },
  });
  const folderNames = legacyAccounts.map((a) => a.folderName);

  const [accounts, emails, attachments, syncLogs] = await prisma.$transaction([
    prisma.emailAccount.updateMany({
      where: { tenantId: legacyTenant.id },
      data: { tenantId: ltsoftId },
    }),
    prisma.processedEmail.updateMany({
      where: { tenantId: legacyTenant.id },
      data: { tenantId: ltsoftId },
    }),
    prisma.attachment.updateMany({
      where: { tenantId: legacyTenant.id },
      data: { tenantId: ltsoftId },
    }),
    prisma.syncLog.updateMany({ where: { tenantId: legacyTenant.id }, data: { tenantId: ltsoftId } }),
  ]);
  console.log(
    `Paso 4: reasignados a "${LTSOFT_SLUG}" — cuentas: ${accounts.count}, correos: ${emails.count}, ` +
      `adjuntos: ${attachments.count}, syncLogs: ${syncLogs.count}.`,
  );

  try {
    await prisma.tenant.delete({ where: { id: legacyTenant.id } });
    console.log(`Tenant placeholder "${LEGACY_SLUG}" eliminado (ya sin filas).`);
  } catch (err) {
    console.warn(`No se pudo eliminar el tenant placeholder "${LEGACY_SLUG}" (no crítico):`, err);
  }

  return { folderNames };
}

/** Mueve cada carpeta de cuenta legacy a STORAGE_ROOT/{ltsoftSlug}/{folderName}. */
async function moveStorage(storageRoot: string, folderNames: string[]): Promise<void> {
  if (folderNames.length === 0) {
    console.log('Paso 5a: no hay carpetas de cuentas legacy que mover en disco.');
    return;
  }
  const ltsoftRoot = join(storageRoot, LTSOFT_SLUG);
  await mkdir(ltsoftRoot, { recursive: true });

  for (const folderName of folderNames) {
    const oldPath = join(storageRoot, folderName);
    const newPath = join(ltsoftRoot, folderName);
    if (existsSync(newPath)) {
      console.log(`  ${folderName}: ya existe en ${newPath} (corrida previa), se omite.`);
      continue;
    }
    if (!existsSync(oldPath)) {
      console.log(`  ${folderName}: no existe en disco en la ruta esperada (${oldPath}), se omite.`);
      continue;
    }
    await mkdir(dirname(newPath), { recursive: true });
    await rename(oldPath, newPath);
    console.log(`  ${folderName}: movido a ${newPath}`);
  }
}

async function updateAttachmentPaths(prisma: PrismaClient, ltsoftId: string): Promise<void> {
  const attachments = await prisma.attachment.findMany({
    where: { tenantId: ltsoftId, NOT: { relativePath: { startsWith: `${LTSOFT_SLUG}/` } } },
    select: { id: true, relativePath: true },
  });
  if (attachments.length === 0) {
    console.log('Paso 5b: relativePath ya tenía el prefijo del tenant (o no hay nada que actualizar).');
    return;
  }
  for (const att of attachments) {
    await prisma.attachment.update({
      where: { id: att.id },
      data: { relativePath: `${LTSOFT_SLUG}/${att.relativePath}` },
    });
  }
  console.log(`Paso 5b: relativePath actualizado en ${attachments.length} adjunto(s).`);
}

async function createMigrationApiKey(prisma: PrismaClient, tenantId: string, tenantSlug: string): Promise<void> {
  const existing = await prisma.tenantApiKey.findFirst({ where: { tenantId, name: 'migración' } });
  if (existing) {
    console.log(
      'Paso 6: ya existe una TenantApiKey "migración" — no se genera otra (la key en claro no se ' +
        'puede recuperar; si se perdió, creá una nueva vía POST /api-keys).',
    );
    return;
  }
  const slugSegment = tenantSlug.slice(0, 8);
  const randomSegment = randomBytes(24).toString('base64url');
  const apiKey = `mdte_${slugSegment}_${randomSegment}`;
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  await prisma.tenantApiKey.create({ data: { tenantId, name: 'migración', keyHash } });
  console.log('Paso 6: API key para el CLI existente (maildte-pull) — GUARDALA AHORA, no se vuelve a mostrar:');
  console.log(`  ${apiKey}`);
}

async function verify(prisma: PrismaClient, storageRoot: string): Promise<void> {
  const remainingLegacy = await prisma.tenant.count({ where: { slug: LEGACY_SLUG } });
  console.log(
    `Verificación: tenant placeholder "${LEGACY_SLUG}" remanente: ` +
      (remainingLegacy === 0 ? 'ninguno (OK).' : 'TODAVÍA EXISTE — revisar manualmente.'),
  );

  const sample = await prisma.attachment.findMany({
    take: 20,
    orderBy: { createdAt: 'desc' },
    select: { relativePath: true },
  });
  let missing = 0;
  for (const { relativePath } of sample) {
    if (!existsSync(join(storageRoot, relativePath))) missing++;
  }
  console.log(
    `Verificación: muestra de ${sample.length} adjunto(s) recientes — ` +
      `${sample.length - missing} existen en disco en la ruta registrada, ${missing} faltantes.`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const storageRoot = process.env.STORAGE_ROOT;
  if (!databaseUrl || !storageRoot) {
    console.error('Faltan las variables de entorno DATABASE_URL y/o STORAGE_ROOT.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const tenant = await ensureLtsoftTenant(prisma);
    await ensureSuperadmin(prisma);
    await ensureLtsoftAdmin(prisma, tenant.id);
    const { folderNames } = await reassignTenantData(prisma, tenant.id);
    await moveStorage(storageRoot, folderNames);
    await updateAttachmentPaths(prisma, tenant.id);
    await createMigrationApiKey(prisma, tenant.id, tenant.slug);
    await verify(prisma, storageRoot);
    console.log('\nMigración a multi-tenancy completada.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Error inesperado en la migración a multi-tenancy:', err);
  process.exitCode = 1;
});
