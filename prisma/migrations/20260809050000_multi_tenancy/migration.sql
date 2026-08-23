-- Migración multi_tenancy (Addendum 08, sección 2)
-- Orden: 1) tipos y tablas nuevas  2) backfill de tenantId en tablas existentes
-- (preserva datos de desarrollo previos a esta migración asignándolos a un
-- tenant placeholder)  3) constraints/índices definitivos  4) RLS FORCE al final,
-- después de todo backfill, para no bloquear las propias sentencias de esta migración.

-- =============================================================
-- 1. Tipos y tablas nuevas
-- =============================================================

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVO', 'SUSPENDIDO');
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'MIEMBRO');

CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVO',
    "maxAccounts" INTEGER NOT NULL DEFAULT 3,
    "maxStorageBytes" BIGINT NOT NULL DEFAULT 5368709120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MIEMBRO',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "currentRefreshTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "tenant_api_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_api_keys_keyHash_key" ON "tenant_api_keys"("keyHash");
CREATE INDEX "tenant_api_keys_tenantId_idx" ON "tenant_api_keys"("tenantId");
ALTER TABLE "tenant_api_keys" ADD CONSTRAINT "tenant_api_keys_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 2. Backfill: tenant placeholder para filas de desarrollo previas a multi-tenancy
--    (no confundir con el tenant "ltsoft" del script de migración real de datos
--    de la sección 6 del addendum — ese es un entregable separado, Prompt 3.5b)
-- =============================================================

INSERT INTO "tenants" ("id", "name", "slug", "status", "maxAccounts", "maxStorageBytes", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'Datos previos a multi-tenancy', 'legacy-pre-tenancy', 'ACTIVO', 999, 5368709120000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "email_accounts")
   OR EXISTS (SELECT 1 FROM "processed_emails")
   OR EXISTS (SELECT 1 FROM "attachments")
   OR EXISTS (SELECT 1 FROM "sync_logs");

-- =============================================================
-- 3. email_accounts: columna + backfill + constraints definitivos
-- =============================================================

ALTER TABLE "email_accounts" ADD COLUMN "tenantId" TEXT;
UPDATE "email_accounts"
SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "slug" = 'legacy-pre-tenancy')
WHERE "tenantId" IS NULL;
ALTER TABLE "email_accounts" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX "email_accounts_email_key";
CREATE UNIQUE INDEX "email_accounts_tenantId_email_key" ON "email_accounts"("tenantId", "email");
CREATE UNIQUE INDEX "email_accounts_tenantId_folderName_key" ON "email_accounts"("tenantId", "folderName");
CREATE INDEX "email_accounts_tenantId_idx" ON "email_accounts"("tenantId");
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 4. processed_emails: columna + backfill desde el tenant de su cuenta
-- =============================================================

ALTER TABLE "processed_emails" ADD COLUMN "tenantId" TEXT;
UPDATE "processed_emails" pe
SET "tenantId" = ea."tenantId"
FROM "email_accounts" ea
WHERE pe."accountId" = ea."id" AND pe."tenantId" IS NULL;
ALTER TABLE "processed_emails" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX "processed_emails_tenantId_receivedAt_idx" ON "processed_emails"("tenantId", "receivedAt");
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 5. attachments: columna + backfill desde el tenant de su correo
-- =============================================================

ALTER TABLE "attachments" ADD COLUMN "tenantId" TEXT;
UPDATE "attachments" a
SET "tenantId" = pe."tenantId"
FROM "processed_emails" pe
WHERE a."emailId" = pe."id" AND a."tenantId" IS NULL;
ALTER TABLE "attachments" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX "attachments_createdAt_id_idx";
CREATE INDEX "attachments_tenantId_createdAt_id_idx" ON "attachments"("tenantId", "createdAt", "id");
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 6. sync_logs: columna + backfill desde el tenant de su cuenta
-- =============================================================

ALTER TABLE "sync_logs" ADD COLUMN "tenantId" TEXT;
UPDATE "sync_logs" sl
SET "tenantId" = ea."tenantId"
FROM "email_accounts" ea
WHERE sl."accountId" = ea."id" AND sl."tenantId" IS NULL;
ALTER TABLE "sync_logs" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX "sync_logs_tenantId_startedAt_idx" ON "sync_logs"("tenantId", "startedAt");
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 7. RLS — defensa en profundidad (skill tenancy). FORCE aplica también al
--    owner de las tablas: cualquier consulta futura sin withTenant() / sin
--    set_config('app.tenant_id', ...) ve 0 filas en vez de fugar datos.
--    Todas las columnas son camelCase ("tenantId"), no snake_case: este
--    proyecto no usa @map a nivel de columna, solo a nivel de tabla.
-- =============================================================

ALTER TABLE "email_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "email_accounts"
    USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "processed_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_emails" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "processed_emails"
    USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "attachments"
    USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "sync_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sync_logs"
    USING ("tenantId" = current_setting('app.tenant_id', true));

-- tenant_api_keys es el mismo caso que users: el AuthGuard tiene que poder
-- resolver a qué tenant pertenece una API key ANTES de tener contexto de
-- tenant (la key es justamente lo que establece ese contexto). SELECT sin
-- restricción por el mismo motivo (keyHash es sha256, no reversible; el
-- service layer de /api-keys igual filtra por tenantId explícitamente para
-- listados dentro de la app); escritura sí queda scoped por tenant.
ALTER TABLE "tenant_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_api_keys" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_api_keys_select_for_auth" ON "tenant_api_keys"
    FOR SELECT USING (true);

CREATE POLICY "tenant_api_keys_insert_tenant_scoped" ON "tenant_api_keys"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY "tenant_api_keys_update_tenant_scoped" ON "tenant_api_keys"
    FOR UPDATE USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY "tenant_api_keys_delete_tenant_scoped" ON "tenant_api_keys"
    FOR DELETE USING ("tenantId" = current_setting('app.tenant_id', true));

-- users es un caso especial con políticas por comando, no una sola tenant_isolation:
-- 1) El login resuelve el usuario por email SIN conocer todavía su tenant (es el
--    propio mecanismo que determina el tenant) — con la política genérica de una
--    sola rama, ANTES de autenticar nunca hay app.tenant_id seteado, así que un
--    SELECT tenant-scoped jamás encontraría a un usuario de tenant real, solo a
--    SUPERADMIN. Por eso SELECT queda sin restricción de tenant a nivel de RLS.
--    El riesgo de confidencialidad es bajo (email/nombre/rol/hash argon2id, no
--    datos de negocio) y el service layer de /users igual filtra por tenantId
--    explícitamente (capa 1 de la skill) para listados dentro de la app.
-- 2) INSERT/UPDATE/DELETE sí quedan estrictamente scoped por tenant (o NULL-en-
--    NULL para el alta/gestión de SUPERADMIN sin contexto de tenant), para que
--    un ADMIN de un tenant jamás pueda escribir usuarios de otro.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_select_for_auth" ON "users"
    FOR SELECT USING (true);

CREATE POLICY "users_insert_tenant_scoped" ON "users"
    FOR INSERT WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)
        OR ("tenantId" IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    );

CREATE POLICY "users_update_tenant_scoped" ON "users"
    FOR UPDATE USING (
        "tenantId" = current_setting('app.tenant_id', true)
        OR ("tenantId" IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    ) WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)
        OR ("tenantId" IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    );

CREATE POLICY "users_delete_tenant_scoped" ON "users"
    FOR DELETE USING (
        "tenantId" = current_setting('app.tenant_id', true)
        OR ("tenantId" IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    );

-- =============================================================
-- 8. Rol de aplicación sin privilegios elevados (skill tenancy, regla 8)
--    El rol "maildte" del .env es superusuario (bootstrap de la imagen oficial
--    de Postgres) y los superusuarios SIEMPRE bypasean RLS, incluso con FORCE
--    — se verificó empíricamente que sin un rol separado, la política de
--    aislamiento de arriba no tiene ningún efecto real contra ese rol.
--    "maildte" sigue siendo el dueño de las tablas y el rol que corren las
--    migraciones (rol administrativo, regla 9 de la skill); la app en runtime
--    debe conectarse con "maildte_app" vía la nueva variable APP_DATABASE_URL.
--    Contraseña de desarrollo local, mismo criterio que POSTGRES_PASSWORD en
--    docker-compose.yml — rotar como parte del procedimiento de despliegue.
-- =============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maildte_app') THEN
        CREATE ROLE "maildte_app" WITH LOGIN PASSWORD 'maildte_app_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "maildte_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "maildte_app";
