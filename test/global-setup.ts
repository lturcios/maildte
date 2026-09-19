import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

import { ADMIN_URL, TEST_DB_NAME, TEST_URL } from './e2e-connection';

/** Crea la BD de test (si no existe) y aplica las migraciones. Corre una sola vez antes de toda la suite e2e. */
export default async function globalSetup(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already exists')) {
      throw err;
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy --schema=./prisma/schema.prisma', {
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'inherit',
  });
}
