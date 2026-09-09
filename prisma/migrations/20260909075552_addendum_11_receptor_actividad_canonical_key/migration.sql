-- Addendum 11 — Identidad del contribuyente y actividad económica, fase 1
--
-- Migración ADITIVA: solo agrega columnas anulables. No reescribe filas, no
-- toca constraints y no cambia ninguna identidad. En particular, se conserva
-- intacto "dte_parties_tenantId_nit_key": la unicidad sigue siendo el NIT.
--
-- No hace falta GRANT ni RLS nuevos. Los GRANT del Addendum 10 son a nivel de
-- tabla (GRANT ... ON "dte_parties" TO "maildte_app"), no por columna, así que
-- una columna nueva queda cubierta; y la policy tenant_isolation es a nivel de
-- fila, indiferente al conjunto de columnas. Verificado contra
-- 20260908035947_purchase_book.
-- =============================================================

-- 1. Actividad económica del receptor, en simetría con "emisorCodActividad".
--
--    Hoy el dato llega en el JSON, el parser lo extrae y se descarta al armar el
--    documento: la actividad solo vive en "dte_parties", donde el upsert la pisa
--    con cada ingesta. Un contribuyente con varias actividades no puede
--    segmentar sus compras porque el histórico ya se perdió.
--
--    Para poblar los documentos ya ingeridos hay que correr el backfill en modo
--    `failed` tras subir PARSER_VERSION (RUNBOOK §9).
ALTER TABLE "purchase_documents" ADD COLUMN     "receptorCodActividad" TEXT,
ADD COLUMN     "receptorDescActividad" TEXT;

-- 2. Clave canónica del contribuyente, SIN constraint todavía.
--
--    Un mismo contribuyente aparece como dos partes cuando unos proveedores lo
--    identifican con el NIT de 14 dígitos y otros con el NIT homologado al DUI,
--    de 9. La clave canónica en cascada (NRC normalizado | NIT-14 | DUI-9) los
--    reúne, pero acá solo se calcula y se guarda: la fase 1 existe justamente
--    para mirar la data real de producción antes de comprometer el constraint.
--
--    SIN índice, a propósito. La consulta del gate de la fase (RUNBOOK §9)
--    agrupa "dte_parties" entera por (tenantId, canonicalKey): es un aggregate
--    sobre toda la tabla, que Postgres resuelve con un seq scan aunque haya
--    índice. La tabla es un catálogo de contrapartes por tenant, de cientos a
--    pocos miles de filas, y en esta fase la columna se escribe pero no se
--    consulta desde la aplicación. El índice que va a hacer falta lo crea el
--    @@unique([tenantId, canonicalKey]) de la fase 2; crearlo ahora sería
--    dejarlo para borrarlo.
ALTER TABLE "dte_parties" ADD COLUMN     "canonicalKey" TEXT;
