-- Corrige las políticas de RLS de "users" que identifican al SUPERADMIN.
--
-- SÍNTOMA
-- El login de SUPERADMIN devolvía 500 de forma intermitente. El error real
-- venía de AuthService al escribir currentRefreshTokenHash:
--   "An operation failed because it depends on one or more records that were
--    required but not found. Record to update not found."
--
-- CAUSA
-- Las políticas escritas en la migración multi_tenancy identifican la fila del
-- SUPERADMIN (tenantId NULL) con:
--     current_setting('app.tenant_id', true) IS NULL
-- Eso solo es cierto mientras la GUC nunca se haya seteado en esa conexión.
-- PrismaService.withTenant() hace SET LOCAL vía set_config(..., true): al
-- terminar la transacción, Postgres NO elimina la GUC, la revierte a string
-- vacío. Verificado en esta misma base:
--
--     -- conexión nueva
--     SELECT current_setting('app.tenant_id', true) IS NULL;  --> true
--     BEGIN; SELECT set_config('app.tenant_id','x',true); COMMIT;
--     SELECT current_setting('app.tenant_id', true) IS NULL;  --> false
--     SELECT current_setting('app.tenant_id', true) = '';     --> true
--
-- Como Prisma usa un pool, cualquier conexión que ya hubiera atendido un
-- request con tenant dejaba de ver la fila del SUPERADMIN para UPDATE. De ahí
-- que el login fallara "a veces": dependía de qué conexión tocara.
--
-- FIX
-- nullif(..., '') normaliza el string vacío de vuelta a NULL, que es lo que la
-- política quiso decir siempre: "no hay tenant en contexto".
--
-- ALCANCE Y SEGURIDAD
-- Solo se tocan las 3 políticas de escritura de "users". Las políticas
-- tenant_isolation de las tablas de negocio comparan `"tenantId" = <guc>`: con
-- string vacío eso da falso y devuelven cero filas, o sea que ya fallaban
-- cerrado y no necesitan cambio. Este fix NO amplía lo que ve nadie: devuelve
-- al SUPERADMIN el acceso a su propia fila, que es el que la política le quería
-- dar desde el principio.

DROP POLICY IF EXISTS "users_insert_tenant_scoped" ON "users";
CREATE POLICY "users_insert_tenant_scoped" ON "users"
    FOR INSERT WITH CHECK (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
        OR ("tenantId" IS NULL AND nullif(current_setting('app.tenant_id', true), '') IS NULL)
    );

DROP POLICY IF EXISTS "users_update_tenant_scoped" ON "users";
CREATE POLICY "users_update_tenant_scoped" ON "users"
    FOR UPDATE USING (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
        OR ("tenantId" IS NULL AND nullif(current_setting('app.tenant_id', true), '') IS NULL)
    ) WITH CHECK (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
        OR ("tenantId" IS NULL AND nullif(current_setting('app.tenant_id', true), '') IS NULL)
    );

DROP POLICY IF EXISTS "users_delete_tenant_scoped" ON "users";
CREATE POLICY "users_delete_tenant_scoped" ON "users"
    FOR DELETE USING (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
        OR ("tenantId" IS NULL AND nullif(current_setting('app.tenant_id', true), '') IS NULL)
    );
