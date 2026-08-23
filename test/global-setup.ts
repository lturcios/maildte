import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const ADMIN_URL = 'postgresql://maildte:secret@localhost:5433/maildte';
const TEST_DB_NAME = 'maildte_test';
const TEST_URL = `postgresql://maildte:secret@localhost:5433/${TEST_DB_NAME}`;

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
