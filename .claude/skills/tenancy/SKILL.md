---
name: tenancy
description: Reglas de aislamiento multi-tenant de MailDTE. Usar SIEMPRE, en cualquier código que consulte o modifique datos de negocio, construya rutas de storage, registre jobs, exponga endpoints o escriba tests, a partir de la Fase 3.5. Cubre resolución del contexto de tenant, scoping obligatorio en Prisma, RLS como defensa en profundidad, rutas de storage por tenant, cuotas y las reglas que impiden fugas de datos entre tenants.
---

# Skill: tenancy

## Cuándo aplica
Todo el código de negocio desde la Fase 3.5. Si una consulta, ruta de archivo, job o respuesta puede tocar datos de más de un tenant, esta skill manda.

## Principio rector
**Ninguna operación de negocio existe sin tenant.** El `tenantId` no es un filtro opcional: es parte de la identidad de cada dato, cada archivo y cada job.

## Resolución del contexto (una sola vía)

```typescript
// TenantContext se resuelve SOLO en la capa de auth y viaja explícito:
// - JWT de usuario  → payload { sub, tenantId, role }
// - API key de tenant (CLI) → TenantApiKey.tenantId
// - SUPERADMIN → tenantId null + rutas /admin/* exclusivas
export interface TenantContext {
  tenantId: string;
  actor: { type: 'user' | 'apikey'; id: string; role: Role };
}
```

Reglas:
1. Los services de negocio reciben `TenantContext` (o `tenantId`) como **primer parámetro** de todo método público. Prohibido leerlo de variables globales o singletons.
2. El `tenantId` NUNCA viene del body, query ni params de una request de negocio. Viene exclusivamente del token/key autenticado. Un `tenantId` en un DTO de negocio es un bug de seguridad.
3. Rutas `/admin/*` (gestión de tenants) requieren rol SUPERADMIN y son las únicas que operan cross-tenant.

## Scoping en Prisma (obligatorio)

```typescript
// SIEMPRE: tenantId en el where, aunque la relación ya lo implique
await prisma.processedEmail.findMany({
  where: { tenantId: ctx.tenantId, accountId, ... },
});

// Acceso por id: findFirst con tenantId, NUNCA findUnique solo por id
const account = await prisma.emailAccount.findFirst({
  where: { id, tenantId: ctx.tenantId, deletedAt: null },
});
if (!account) throw new NotFoundException(...); // 404, no 403: no revelar existencia
```

4. Todo modelo de negocio lleva columna `tenantId` **denormalizada** (también los hijos: `ProcessedEmail`, `Attachment`, `SyncLog`), con índice compuesto que empieza por `tenantId`.
5. Los `create` de hijos copian el `tenantId` del padre en la misma transacción.
6. Acceso a un recurso de otro tenant → **404** (nunca 403: un 403 confirma que el recurso existe).
7. `groupBy`/`aggregate` de stats: `where: { tenantId }` siempre presente.

## RLS — defensa en profundidad (patrón estándar LTSOFT)

El scoping en services es la primera línea; RLS en PostgreSQL es la red de seguridad ante cualquier query que lo olvide:

```sql
ALTER TABLE processed_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON processed_emails
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Repetir en: email_accounts, attachments, sync_logs, tenant_api_keys, users
```

```typescript
// PrismaService: helper que fija el tenant en la transacción
async withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return this.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`; // SET LOCAL
    return fn(tx);
  });
}
```

8. El usuario de BD de la aplicación NO es owner de las tablas ni tiene `BYPASSRLS` (FORCE RLS aplica también al owner, pero el usuario de app se mantiene separado igualmente).
9. Procesos administrativos (migraciones, script de migración de datos) usan un rol distinto documentado.
10. RLS no reemplaza el scoping explícito: ambos conviven; un test e2e verifica que una query sin `set_config` retorna 0 filas.

## Storage por tenant

```
{STORAGE_ROOT}/{tenantSlug}/{accountFolder}/{YYYY-MM}/{json|pdf}/{archivo}
```

11. `tenantSlug`: único, inmutable tras la creación, `[a-z0-9-]`, generado del nombre del tenant. Renombrar el tenant NO renombra el slug (las rutas persistidas no se tocan).
12. `StorageService` recibe el tenant en su contexto de operación; `resolveSafe` valida ahora `startsWith(STORAGE_ROOT/tenantSlug + sep)` — un path de otro tenant es traversal aunque esté dentro de STORAGE_ROOT.
13. `relativePath` persistido incluye el tenantSlug (consistencia BD ↔ disco).

## Jobs y locks

14. Payload de jobs: `{ tenantId, accountId, trigger }`. El worker revalida al inicio que la cuenta pertenece al tenant del payload y que el tenant está `ACTIVO`; si no, termina sin error (log WARN).
15. Locks siguen siendo por cuenta (`lock:sync:{accountId}`): los UUID ya no colisionan entre tenants.
16. Tenant SUSPENDIDO: sus jobs repetibles se remueven (mismo mecanismo que ERROR_AUTH); reactivar el tenant los re-registra.

## Cuotas (plan comercial)

17. `Tenant.maxAccounts` y `Tenant.maxStorageBytes` se validan: al crear cuenta (conteo) y al guardar adjuntos (acumulado por tenant, cacheado en Redis con reconciliación en cada SyncLog). Cuota excedida en sync → el correo se registra `ERROR` con `QUOTA_EXCEEDED` y el sync continúa (no se pierde el registro, solo no se descarga el archivo hasta ampliar).

## Tests obligatorios de aislamiento (agregar al checklist)

- [ ] Usuario del tenant A pide `GET /emails/:id` de un correo del tenant B → 404.
- [ ] Listados con auth del tenant A nunca contienen filas de B (sembrar ambos).
- [ ] API key del tenant A + `accountId` del tenant B en export/manifest → 404.
- [ ] `resolveSafe` con relativePath del tenantSlug B bajo contexto A → 400.
- [ ] Query directa sin `set_config` de tenant contra tabla con RLS → 0 filas (e2e).
- [ ] Job con `{ tenantId: A, accountId: de B }` → termina sin procesar, log WARN.
- [ ] Tenant SUSPENDIDO: sync no corre y API de negocio retorna 403 TENANT_SUSPENDED.

## Prohibido
- `findUnique({ where: { id } })` sobre modelos de negocio en rutas de tenant.
- Construir rutas de storage sin pasar por el StorageService con contexto.
- Exponer `tenantId`/`tenantSlug` de otros tenants en cualquier respuesta.
- Contadores o stats globales en endpoints de tenant (solo en /admin/*).
- Aceptar tenantId como input del cliente en endpoints de negocio.
