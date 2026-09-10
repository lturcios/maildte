-- Addendum 11 — Identidad del contribuyente, fase 2 (punto 2)
--
-- Migración ADITIVA: agrega una columna anulable, un índice y un backfill
-- determinístico. NO toca constraints. En particular sigue intacto
-- "dte_parties_tenantId_nit_key": la unicidad declarada sigue siendo el NIT
-- hasta que el script de fusión (§4 del addendum) elimine los duplicados del
-- histórico. Recién entonces se reemplaza por (tenantId, canonicalKey).
--
-- No hace falta GRANT ni RLS nuevos, por lo mismo que la migración de la fase 1:
-- los GRANT del Addendum 10 son a nivel de tabla y la policy tenant_isolation es
-- a nivel de fila, las dos indiferentes al conjunto de columnas.
-- =============================================================

-- 1. Segundo identificador del contribuyente.
--
--    Con la identidad resuelta por clave canónica, una parte legítimamente tiene
--    un NIT de 14 dígitos y un NIT homologado al DUI de 9: son los dos números
--    con los que sus proveedores la referencian. Si los dos se escriben en la
--    misma columna "nit", cada documento pisa al anterior según qué proveedor
--    facturó último — y peor, escribir "nit" en una parte ya existente la haría
--    chocar contra su hermana por el unique vigente.
ALTER TABLE "dte_parties" ADD COLUMN     "dui" TEXT;

-- 2. Backfill determinístico de las filas existentes.
--
--    "nit" guarda hoy indistintamente el NIT de 14 dígitos o el homologado al
--    DUI de 9: la longitud del número sin separadores es lo que los distingue,
--    igual que en splitSupplierId() y en resolveCanonicalKey(). Las filas cuyo
--    identificador mide 9 dígitos ya son un DUI, así que ese mismo valor
--    —normalizado, sin separadores, que es como lo escribe la ingesta— pasa
--    también a "dui". Ninguna fila cambia de identidad ni pierde su "nit".
UPDATE "dte_parties"
SET "dui" = regexp_replace("nit", '\D', '', 'g')
WHERE "dui" IS NULL
  AND length(regexp_replace("nit", '\D', '', 'g')) = 9;

-- 3. Índice de trabajo sobre la clave canónica.
--
--    La fase 1 lo omitió a propósito, y con razón: entonces la columna se
--    escribía y no se consultaba desde la aplicación. Eso ya no es cierto —
--    desde este cambio la ingesta la consulta dos veces por documento (una por
--    parte) y el export una vez por archivo, en el camino caliente. Es un índice
--    de vida corta: lo reemplaza el UNIQUE (tenantId, canonicalKey) del cierre
--    de la fase, que da la misma búsqueda y además el constraint.
CREATE INDEX "dte_parties_tenantId_canonicalKey_idx" ON "dte_parties"("tenantId", "canonicalKey");
