-- Addendum 11 — fase 3 (rebanada 1): catálogo de actividad y mapeo de proveedores
--
-- Tres cambios de esquema:
--   1. "purchase_activities"        — el catálogo de actividades POR receptor.
--   2. "supplier_activity_defaults" — el mapeo (proveedor, receptor) -> actividad.
--   3. "purchase_documents"         — el override de actividad del documento.
--
-- Las DOS FK a "purchase_activities" son ON DELETE RESTRICT, la del documento y
-- la del mapeo. Es lo que ya promete PurchaseActivityService.remove() con su 422
-- para una actividad en uso, y evita que un SET NULL deje el documento con
-- "activityAssignedById" / "activityAssignedAt" apuntando a una decisión sobre
-- una actividad que ya no se puede resolver. Retirar una actividad en uso es
-- desactivarla ("active" = false), no borrarla.
--
-- La sección final (GRANT + RLS) NO la genera Prisma y es obligatoria: sin ella
-- las dos tablas nuevas quedan sin aislamiento por tenant y fugan datos apenas
-- se consulten fuera de withTenant(). Se replica la forma del Addendum 10
-- (20260908035947_purchase_book) sin variantes.

-- AlterTable
ALTER TABLE "purchase_documents" ADD COLUMN     "activityAssignedAt" TIMESTAMP(3),
ADD COLUMN     "activityAssignedById" TEXT,
ADD COLUMN     "activityId" TEXT;

-- CreateTable
CREATE TABLE "purchase_activities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receptorId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "codActividad" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultTipoOperacion" INTEGER,
    "defaultClasificacion" INTEGER,
    "defaultSector" INTEGER,
    "defaultTipoCostoGasto" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_activity_defaults" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receptorId" TEXT NOT NULL,
    "emisorId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_activity_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_activities_tenantId_idx" ON "purchase_activities"("tenantId");

-- CreateIndex
CREATE INDEX "purchase_activities_tenantId_receptorId_active_idx" ON "purchase_activities"("tenantId", "receptorId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_activities_tenantId_receptorId_nombre_key" ON "purchase_activities"("tenantId", "receptorId", "nombre");

-- CreateIndex
CREATE INDEX "supplier_activity_defaults_tenantId_idx" ON "supplier_activity_defaults"("tenantId");

-- CreateIndex
CREATE INDEX "supplier_activity_defaults_tenantId_receptorId_activityId_idx" ON "supplier_activity_defaults"("tenantId", "receptorId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_activity_defaults_tenantId_receptorId_emisorId_key" ON "supplier_activity_defaults"("tenantId", "receptorId", "emisorId");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_activityId_idx" ON "purchase_documents"("tenantId", "activityId");

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "purchase_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_activities" ADD CONSTRAINT "purchase_activities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_activities" ADD CONSTRAINT "purchase_activities_receptorId_fkey" FOREIGN KEY ("receptorId") REFERENCES "dte_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_activity_defaults" ADD CONSTRAINT "supplier_activity_defaults_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_activity_defaults" ADD CONSTRAINT "supplier_activity_defaults_receptorId_fkey" FOREIGN KEY ("receptorId") REFERENCES "dte_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_activity_defaults" ADD CONSTRAINT "supplier_activity_defaults_emisorId_fkey" FOREIGN KEY ("emisorId") REFERENCES "dte_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_activity_defaults" ADD CONSTRAINT "supplier_activity_defaults_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "purchase_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- Addendum 11 — fase 3: GRANT + RLS (escrito a mano)
--
-- Prisma NO genera nada de esta sección: ni los GRANT al rol de aplicación ni
-- las políticas de aislamiento. Si se omite, las 2 tablas nuevas quedan sin RLS
-- y fugan datos entre tenants apenas se consulten fuera de withTenant().
--
-- "purchase_documents" no necesita GRANT ni policy nuevos: los del Addendum 10
-- son a nivel de tabla y de fila, indiferentes a las columnas y a los índices
-- que agrega esta migración.
-- =============================================================

-- 1. GRANT explícitos para el rol de aplicación.
--
--    Igual que en la migración purchase_book: la migración multi_tenancy ya
--    dejó ALTER DEFAULT PRIVILEGES para las tablas nuevas de este mismo owner,
--    pero los GRANT se escriben explícitos para que la migración se pueda leer
--    sin depender de un efecto a distancia de otra anterior.
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_activities" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_activity_defaults" TO "maildte_app";

-- 2. RLS FORCE + policy tenant_isolation en las 2 tablas.
--
--    FORCE aplica también al owner: cualquier consulta futura sin withTenant()
--    ve 0 filas en vez de fugar datos de otros tenants.
--
--    nullif(..., '') normaliza el string vacío que deja Postgres al revertir un
--    SET LOCAL al terminar la transacción. Misma forma exacta que introdujo
--    20260902000000_fix_superadmin_rls_null_tenant, para que todas las
--    políticas del proyecto se lean igual.
--
--    Sobre estas dos tablas el aislamiento por tenant importa el doble: el
--    mapeo de proveedores ES el criterio contable de un contribuyente, y una
--    fuga acá aplicaría la decisión de una empresa a las compras de otra.

ALTER TABLE "purchase_activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_activities"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "supplier_activity_defaults" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_activity_defaults" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_activity_defaults"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));
