import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APP_TEST_URL, REDIS_TEST_URL, TEST_URL } from './e2e-connection';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_URL;
process.env.APP_DATABASE_URL = APP_TEST_URL;
process.env.REDIS_URL = REDIS_TEST_URL;
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'e2e-test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-test-jwt-refresh-secret-0123456789abcdef01';
process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'maildte-e2e-storage-'));
process.env.DEFAULT_SYNC_INTERVAL = '300';
process.env.TZ_FOLDER = 'America/El_Salvador';
process.env.LOG_LEVEL = 'silent';
process.env.MAX_ATTACHMENT_MB = '25';
