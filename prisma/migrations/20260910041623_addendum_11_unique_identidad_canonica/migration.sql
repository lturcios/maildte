-- Addendum 11 — Identidad del contribuyente, fase 2 (punto 1): el constraint
--
-- Cierra la fase. Desde el punto 2 la ingesta RESUELVE la identidad por la clave
-- canónica; desde acá la base la GARANTIZA: dos filas del mismo contribuyente en
-- el mismo tenant dejan de ser representables.
--
-- DESVÍO RESPECTO DEL TEXTO DEL ADDENDUM (§2, "Consecuencia de esquema"):
-- el UNIQUE (tenantId, nit) **NO se reemplaza**, se conserva junto al nuevo.
-- Tres razones, y ninguna es inercia:
--
--   1. Ese constraint nunca causó el split del contribuyente. Lo causaba
--      *resolver la identidad* por "nit" en la ingesta, que es lo que corrigió
--      el punto 2. Quitarlo no arregla nada que siga roto.
--   2. Es lo único que protege de duplicados a las partes con "canonicalKey"
--      NULA. En Postgres los nulos no colisionan entre sí, así que un UNIQUE
--      sobre la clave canónica no dice absolutamente nada de ese caso: sin el
--      UNIQUE del identificador, dos partes sin clave con el mismo "nit"
--      pasarían sin que nada las detenga.
--   3. No puede provocar un P2002 con la lógica actual de findParty(): "nit"
--      nunca se reescribe en un update, y el "create" solo ocurre cuando ni la
--      clave canónica ni el identificador encontraron fila.
--
-- No hace falta GRANT ni RLS nuevos: los GRANT del Addendum 10 son a nivel de
-- tabla y la policy tenant_isolation es a nivel de fila, las dos indiferentes a
-- los índices. El UNIQUE es por (tenantId, canonicalKey), así que no cruza
-- tenants: dos contribuyentes distintos de tenants distintos pueden compartir
-- clave.
-- =============================================================

-- 1. Guarda previa: si el histórico no se fusionó, la migración aborta con un
--    mensaje que dice qué hacer.
--
--    Sin esto, el CREATE UNIQUE INDEX falla con el error crudo de Postgres
--    ("could not create unique index ... Key ("tenantId", "canonicalKey")=(...)
--    is duplicated"), que no menciona el script de fusión ni el addendum. Quien
--    despliegue esto en una instalación que todavía tiene contribuyentes
--    partidos va a leer ESTE mensaje, no el del índice.
DO $$
DECLARE
  grupos_duplicados integer;
  ejemplo text;
BEGIN
  SELECT count(*), min(g."canonicalKey")
    INTO grupos_duplicados, ejemplo
  FROM (
    SELECT "tenantId", "canonicalKey"
    FROM "dte_parties"
    WHERE "canonicalKey" IS NOT NULL
    GROUP BY "tenantId", "canonicalKey"
    HAVING count(*) > 1
  ) g;

  IF grupos_duplicados > 0 THEN
    RAISE EXCEPTION
      'Hay % contribuyente(s) partido(s) en dte_parties (por ejemplo la clave canónica %). El UNIQUE (tenantId, canonicalKey) no se puede crear hasta fusionarlos.',
      grupos_duplicados, ejemplo
      USING HINT =
        'Correr primero el script de fusión: pnpm run merge:dte-parties -- --tenant=<slug> --dry-run y luego --apply (RUNBOOK 9.d). La consulta que los lista está en el RUNBOOK 9.e.';
  END IF;
END $$;

-- 2. El índice no único de la migración anterior se elimina.
--
--    Era explícitamente de vida corta: se creó para la búsqueda por clave que la
--    ingesta hace dos veces por documento y el export una vez por archivo. El
--    UNIQUE que sigue da esa MISMA búsqueda —mismas columnas, mismo orden— y
--    además el constraint. Mantener los dos sería pagar dos veces la escritura
--    del índice en cada alta de parte sin ganar ninguna lectura.
DROP INDEX "dte_parties_tenantId_canonicalKey_idx";

-- 3. La identidad del contribuyente, ahora garantizada por la base.
CREATE UNIQUE INDEX "dte_parties_tenantId_canonicalKey_key" ON "dte_parties"("tenantId", "canonicalKey");
