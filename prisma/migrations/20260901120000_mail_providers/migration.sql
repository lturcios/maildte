-- Migración mail_providers (Addendum 09, fase F1)
-- Catálogo maestro global de servicios de correo + vínculo desde email_accounts.
-- Orden: 1) tipo y tablas nuevas  2) columna providerId en email_accounts
-- 3) grants  4) nota sobre RLS (ver sección 4, es deliberado que NO la tengan).

-- =============================================================
-- 1. Tipo y tablas nuevas
-- =============================================================

CREATE TYPE "DomainMatchKind" AS ENUM ('DOMAIN', 'MX_SUFFIX');

CREATE TABLE "mail_providers" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "defaultMailbox" TEXT NOT NULL DEFAULT 'INBOX',
    "strict" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "helpUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_providers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mail_providers_key_key" ON "mail_providers"("key");

CREATE TABLE "mail_provider_domains" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" "DomainMatchKind" NOT NULL DEFAULT 'DOMAIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_provider_domains_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mail_provider_domains_providerId_idx" ON "mail_provider_domains"("providerId");

-- La unicidad es por (kind, domain), no por domain solo: "outlook.com" existe
-- como dominio de correo personal Y como sufijo del MX de Microsoft 365.
CREATE UNIQUE INDEX "mail_provider_domains_kind_domain_key" ON "mail_provider_domains"("kind", "domain");

ALTER TABLE "mail_provider_domains" ADD CONSTRAINT "mail_provider_domains_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "mail_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================
-- 2. email_accounts.providerId
--    Nullable a propósito (ADR-09.2): NULL = "servidor personalizado", y en ese
--    caso mandan las columnas imapHost/imapPort/imapSecure de la propia cuenta.
--    Por eso esta migración NO las toca ni las borra, y no necesita backfill:
--    todas las cuentas existentes quedan como personalizadas y siguen andando.
--    El vínculo con los perfiles sembrados lo hace, aparte y de forma opcional,
--    scripts/seed-mail-providers.ts.
--
--    ON DELETE RESTRICT (ADR-09.1): un perfil referenciado por alguna cuenta no
--    se puede borrar. Ojo: las cuentas con soft delete (deletedAt IS NOT NULL)
--    conservan su providerId y también cuentan como referencia.
-- =============================================================

ALTER TABLE "email_accounts" ADD COLUMN "providerId" TEXT;
CREATE INDEX "email_accounts_providerId_idx" ON "email_accounts"("providerId");
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "mail_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 3. Grants para el rol de aplicación
--    La migración multi_tenancy ya dejó un ALTER DEFAULT PRIVILEGES que cubre
--    las tablas nuevas creadas por este mismo owner; estos GRANT son explícitos
--    a propósito, para que el permiso quede documentado junto a la tabla y no
--    dependa de un efecto a distancia de otra migración.
-- =============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_providers" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_provider_domains" TO "maildte_app";

-- =============================================================
-- 4. RLS: estas dos tablas NO la llevan, y es deliberado
--
--    Contradice a simple vista la regla de RLS FORCE de la migración
--    multi_tenancy, así que queda escrito acá: mail_providers y
--    mail_provider_domains son un CATÁLOGO GLOBAL, no datos de negocio de un
--    tenant. No tienen columna "tenantId", así que no hay nada contra qué
--    escribir una policy de aislamiento.
--
--    En Postgres, una tabla sin ENABLE ROW LEVEL SECURITY queda sin restricción
--    para cualquier rol con GRANT. Eso es justo lo que se necesita: el catálogo
--    debe leerse dentro de las transacciones de PrismaService.withTenant()
--    (que hacen SET LOCAL app.tenant_id), y esas lecturas funcionan sin policy.
--
--    La ESCRITURA se restringe en la capa de aplicación con @Roles(SUPERADMIN)
--    sobre el controller de administración. Si en el futuro se quisiera reforzar
--    en la base, la vía correcta es un rol distinto para el catálogo, no una
--    policy sobre app.tenant_id: no hay tenant al que amarrar la regla.
-- =============================================================
