import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://maildte:secret@localhost:5433/maildte_test';
// Rol restringido (no superusuario): sin esto, RLS queda bypaseado y los tests de
// aislamiento no prueban nada real (ver comentario en la migración multi_tenancy).
process.env.APP_DATABASE_URL =
  'postgresql://maildte_app:maildte_app_dev_only@localhost:5433/maildte_test';
process.env.REDIS_URL = 'redis://localhost:6379/1'; // DB 1: aislada de los datos de desarrollo (DB 0)
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'e2e-test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-test-jwt-refresh-secret-0123456789abcdef01';
process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'maildte-e2e-storage-'));
process.env.DEFAULT_SYNC_INTERVAL = '300';
process.env.TZ_FOLDER = 'America/El_Salvador';
process.env.LOG_LEVEL = 'silent';
process.env.MAX_ATTACHMENT_MB = '25';
