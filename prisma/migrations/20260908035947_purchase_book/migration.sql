-- CreateEnum
CREATE TYPE "DteParseStatus" AS ENUM ('PARSEADO', 'DUPLICADO', 'IGNORADO_TIPO', 'VERSION_NO_SOPORTADA', 'NO_ES_DTE', 'JSON_INVALIDO', 'ARCHIVO_DEMASIADO_GRANDE', 'ARCHIVO_FALTANTE', 'ERROR');

-- CreateTable
CREATE TABLE "dte_parties" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "nrc" TEXT,
    "nombre" TEXT NOT NULL,
    "nombreComercial" TEXT,
    "codActividad" TEXT,
    "descActividad" TEXT,
    "departamento" TEXT,
    "municipio" TEXT,
    "distrito" TEXT,
    "complemento" TEXT,
    "telefono" TEXT,
    "correo" TEXT,
    "seenAsEmisor" BOOLEAN NOT NULL DEFAULT false,
    "seenAsReceptor" BOOLEAN NOT NULL DEFAULT false,
    "defaultTipoOperacion" INTEGER,
    "defaultClasificacion" INTEGER,
    "defaultSector" INTEGER,
    "defaultTipoCostoGasto" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dte_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dte_parse_results" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "status" "DteParseStatus" NOT NULL,
    "tipoDte" TEXT,
    "version" INTEGER,
    "codigoGeneracion" TEXT,
    "documentId" TEXT,
    "errorDetail" TEXT,
    "parserVersion" INTEGER NOT NULL,
    "parsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dte_parse_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ambiente" TEXT NOT NULL,
    "tipoDte" TEXT NOT NULL,
    "numeroControl" TEXT NOT NULL,
    "codigoGeneracion" TEXT NOT NULL,
    "tipoModelo" INTEGER NOT NULL,
    "tipoOperacion" INTEGER NOT NULL,
    "tipoContingencia" INTEGER,
    "motivoContin" TEXT,
    "fecEmi" DATE NOT NULL,
    "horEmi" TEXT NOT NULL,
    "tipoMoneda" TEXT NOT NULL,
    "emisorId" TEXT NOT NULL,
    "emisorNit" TEXT NOT NULL,
    "emisorNrc" TEXT,
    "emisorNombre" TEXT NOT NULL,
    "emisorNombreComercial" TEXT,
    "emisorCodActividad" TEXT,
    "emisorTipoEstablecimiento" TEXT,
    "emisorCodEstable" TEXT,
    "emisorCodPuntoVenta" TEXT,
    "receptorId" TEXT NOT NULL,
    "receptorNit" TEXT NOT NULL,
    "receptorNrc" TEXT,
    "receptorNombre" TEXT NOT NULL,
    "receptorNombreComercial" TEXT,
    "totalNoSuj" DECIMAL(18,8) NOT NULL,
    "totalExenta" DECIMAL(18,8) NOT NULL,
    "totalGravada" DECIMAL(18,8) NOT NULL,
    "subTotalVentas" DECIMAL(18,8) NOT NULL,
    "descuNoSuj" DECIMAL(18,8) NOT NULL,
    "descuExenta" DECIMAL(18,8) NOT NULL,
    "descuGravada" DECIMAL(18,8) NOT NULL,
    "porcentajeDescuento" DECIMAL(18,8) NOT NULL,
    "totalDescu" DECIMAL(18,8) NOT NULL,
    "subTotal" DECIMAL(18,8) NOT NULL,
    "ivaRetenido" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "ivaPercibido" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "retencionRenta" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "ivaCreditoFiscal" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "montoTotalOperacion" DECIMAL(18,8) NOT NULL,
    "totalNoGravado" DECIMAL(18,8) NOT NULL,
    "totalPagar" DECIMAL(18,8) NOT NULL,
    "saldoFavor" DECIMAL(18,8) NOT NULL,
    "totalLetras" TEXT NOT NULL,
    "condicionOperacion" INTEGER NOT NULL,
    "numPagoElectronico" TEXT,
    "observaciones" TEXT,
    "selloRecibido" TEXT,
    "documentoRelacionado" JSONB,
    "otrosDocumentos" JSONB,
    "ventaTercero" JSONB,
    "extension" JSONB,
    "apendice" JSONB,
    "rawJson" JSONB NOT NULL,
    "anexoTipoOperacion" INTEGER,
    "anexoClasificacion" INTEGER,
    "anexoSector" INTEGER,
    "anexoTipoCostoGasto" INTEGER,
    "anexoNota" TEXT,
    "classifiedById" TEXT,
    "classifiedAt" TIMESTAMP(3),
    "parserVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_document_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "numItem" INTEGER NOT NULL,
    "tipoItem" INTEGER NOT NULL,
    "numeroDocumento" TEXT,
    "cantidad" DECIMAL(18,8) NOT NULL,
    "codigo" TEXT,
    "codTributo" TEXT,
    "uniMedida" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "precioUni" DECIMAL(18,8) NOT NULL,
    "montoDescu" DECIMAL(18,8) NOT NULL,
    "ventaNoSuj" DECIMAL(18,8) NOT NULL,
    "ventaExenta" DECIMAL(18,8) NOT NULL,
    "ventaGravada" DECIMAL(18,8) NOT NULL,
    "tributos" TEXT[],
    "psv" DECIMAL(18,8) NOT NULL,
    "noGravado" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "purchase_document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_document_taxes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "valor" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "purchase_document_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_document_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "montoPago" DECIMAL(18,8) NOT NULL,
    "referencia" TEXT,
    "plazo" TEXT,
    "periodo" INTEGER,

    CONSTRAINT "purchase_document_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dte_parties_tenantId_seenAsEmisor_idx" ON "dte_parties"("tenantId", "seenAsEmisor");

-- CreateIndex
CREATE INDEX "dte_parties_tenantId_seenAsReceptor_idx" ON "dte_parties"("tenantId", "seenAsReceptor");

-- CreateIndex
CREATE UNIQUE INDEX "dte_parties_tenantId_nit_key" ON "dte_parties"("tenantId", "nit");

-- CreateIndex
CREATE UNIQUE INDEX "dte_parse_results_attachmentId_key" ON "dte_parse_results"("attachmentId");

-- CreateIndex
CREATE INDEX "dte_parse_results_tenantId_status_idx" ON "dte_parse_results"("tenantId", "status");

-- CreateIndex
CREATE INDEX "dte_parse_results_documentId_idx" ON "dte_parse_results"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_documents_attachmentId_key" ON "purchase_documents"("attachmentId");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_fecEmi_idx" ON "purchase_documents"("tenantId", "fecEmi");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_receptorId_fecEmi_idx" ON "purchase_documents"("tenantId", "receptorId", "fecEmi");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_emisorId_fecEmi_idx" ON "purchase_documents"("tenantId", "emisorId", "fecEmi");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_accountId_fecEmi_idx" ON "purchase_documents"("tenantId", "accountId", "fecEmi");

-- CreateIndex
CREATE INDEX "purchase_documents_tenantId_numeroControl_idx" ON "purchase_documents"("tenantId", "numeroControl");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_documents_tenantId_codigoGeneracion_key" ON "purchase_documents"("tenantId", "codigoGeneracion");

-- CreateIndex
CREATE INDEX "purchase_document_items_tenantId_idx" ON "purchase_document_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_items_documentId_numItem_key" ON "purchase_document_items"("documentId", "numItem");

-- CreateIndex
CREATE INDEX "purchase_document_taxes_tenantId_idx" ON "purchase_document_taxes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_taxes_documentId_codigo_key" ON "purchase_document_taxes"("documentId", "codigo");

-- CreateIndex
CREATE INDEX "purchase_document_payments_tenantId_idx" ON "purchase_document_payments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_payments_documentId_position_key" ON "purchase_document_payments"("documentId", "position");

-- AddForeignKey
ALTER TABLE "dte_parties" ADD CONSTRAINT "dte_parties_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dte_parse_results" ADD CONSTRAINT "dte_parse_results_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dte_parse_results" ADD CONSTRAINT "dte_parse_results_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dte_parse_results" ADD CONSTRAINT "dte_parse_results_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "purchase_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_emisorId_fkey" FOREIGN KEY ("emisorId") REFERENCES "dte_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_receptorId_fkey" FOREIGN KEY ("receptorId") REFERENCES "dte_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_document_items" ADD CONSTRAINT "purchase_document_items_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "purchase_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_document_taxes" ADD CONSTRAINT "purchase_document_taxes_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "purchase_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_document_payments" ADD CONSTRAINT "purchase_document_payments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "purchase_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================
-- Addendum 10 — Libro de compras: GRANT + RLS (escrito a mano)
--
-- Prisma NO genera nada de esta sección: ni los GRANT al rol de aplicación ni
-- las políticas de aislamiento. Si se omite, las 6 tablas quedan sin RLS y
-- fugan datos entre tenants apenas se consulten fuera de withTenant().
-- =============================================================

-- 1. GRANT explícitos para el rol de aplicación.
--
--    La migración multi_tenancy ya dejó ALTER DEFAULT PRIVILEGES para las
--    tablas nuevas creadas por este mismo owner; estos GRANT son explícitos
--    igual que en la migración mail_providers, para que la migración se pueda
--    leer sin depender de un efecto a distancia de otra anterior.
GRANT SELECT, INSERT, UPDATE, DELETE ON "dte_parties" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "dte_parse_results" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_documents" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_document_items" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_document_taxes" TO "maildte_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_document_payments" TO "maildte_app";

-- 2. RLS FORCE + policy tenant_isolation en las 6 tablas.
--
--    FORCE aplica también al owner: cualquier consulta futura sin withTenant()
--    ve 0 filas en vez de fugar datos de otros tenants.
--
--    nullif(..., '') normaliza el string vacío que deja Postgres al revertir un
--    SET LOCAL al terminar la transacción. Sin el nullif la comparación contra
--    '' igual da falso (falla cerrado), pero se mantiene la forma introducida
--    por 20260902000000_fix_superadmin_rls_null_tenant para que todas las
--    políticas del proyecto se lean igual.
--
--    Las tablas hijas (items, taxes, payments) llevan tenantId propio aunque no
--    tengan FK a tenants: la policy necesita la columna para poder filtrar sin
--    hacer un join contra purchase_documents en cada fila.

ALTER TABLE "dte_parties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dte_parties" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "dte_parties"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "dte_parse_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dte_parse_results" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "dte_parse_results"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "purchase_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_documents"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "purchase_document_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_document_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_document_items"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "purchase_document_taxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_document_taxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_document_taxes"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE "purchase_document_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_document_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_document_payments"
    USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));
