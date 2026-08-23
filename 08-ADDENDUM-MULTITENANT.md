# Addendum 08 — Multi-Tenancy — MailDTE Collector
**Conversión a SaaS multi-tenant con aislamiento total por cliente**

---

## 0. Decisión de secuencia (leer primero)

**Momento de implementación: Fase 3.5 — después de concluir el Prompt 3.2 y ANTES de ejecutar 4.1 y 5.1.**

Justificación:
1. Multi-tenancy atraviesa modelo de datos, auth, storage y jobs: todo código posterior escrito sin `tenantId` es retrabajo garantizado.
2. El despliegue y RUNBOOK (4.1) cambian con el modelo de auth (JWT + API keys por tenant): escribirlos una sola vez.
3. El panel (5.1) necesita login por tenant de todas formas; construirlo sobre el modelo final evita rehacerlo.
4. Aún no hay clientes en producción: la migración de datos es un script de minutos. Con clientes activos sería una operación de riesgo.

Estado esperado al iniciar: prompts 0.1 → 3.2 ejecutados.

## 1. Modelo conceptual

```
Tenant (cliente del servicio, ej. "Despacho Contable Rivera")
 ├── Users (personas con login: email + contraseña → JWT)
 ├── TenantApiKeys (llaves máquina para maildte-pull / integraciones)
 ├── EmailAccounts (sus buzones IMAP)
 │    └── ProcessedEmails → Attachments
 └── SyncLogs

SUPERADMIN (LTSOFT): gestiona tenants, planes y cuotas vía /admin/*.
                     No ve el contenido de los tenants por la API de
                     negocio (solo métricas agregadas y estado).
```

Aislamiento en tres capas: (1) scoping explícito en services, (2) RLS en PostgreSQL, (3) rutas de storage separadas por `tenantSlug` con validación de traversal por tenant. El detalle operativo de las tres vive en la **skill `tenancy`** (instalarla en `.claude/skills/tenancy/` antes de la Fase 3.5).

## 2. Cambios de esquema (Prisma)

### Modelos nuevos

```prisma
enum TenantStatus { ACTIVO SUSPENDIDO }
enum Role { SUPERADMIN ADMIN MIEMBRO }

model Tenant {
  id              String       @id @default(uuid())
  name            String
  slug            String       @unique      // [a-z0-9-], inmutable
  status          TenantStatus @default(ACTIVO)
  maxAccounts     Int          @default(3)
  maxStorageBytes BigInt       @default(5368709120) // 5 GB
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  users    User[]
  apiKeys  TenantApiKey[]
  accounts EmailAccount[]

  @@map("tenants")
}

model User {
  id           String    @id @default(uuid())
  tenantId     String?                       // null solo para SUPERADMIN
  tenant       Tenant?   @relation(fields: [tenantId], references: [id])
  email        String    @unique
  name         String
  passwordHash String                        // argon2id
  role         Role      @default(MIEMBRO)
  active       Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())

  @@index([tenantId])
  @@map("users")
}

model TenantApiKey {
  id         String    @id @default(uuid())
  tenantId   String
  tenant     Tenant    @relation(fields: [tenantId], references: [id])
  name       String                          // "CLI oficina", "n8n"
  keyHash    String    @unique               // sha256 de la key; la key solo se muestra al crear
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  @@index([tenantId])
  @@map("tenant_api_keys")
}
```

### Modelos existentes — columna denormalizada

```prisma
// Agregar a EmailAccount, ProcessedEmail, Attachment y SyncLog:
tenantId String
tenant   Tenant @relation(fields: [tenantId], references: [id])
```

### Constraints e índices que cambian

| Antes | Después | Razón |
|---|---|---|
| `EmailAccount.email @unique` | `@@unique([tenantId, email])` | Dos tenants pueden registrar el mismo buzón (ej. contador externo y la empresa) |
| — | `@@unique([tenantId, folderName])` en EmailAccount | folderName único por tenant, no global |
| `@@unique([accountId, messageId])` | **Se conserva intacto** | accountId ya es único global; la idempotencia no cambia |
| `@@index([accountId, receivedAt])` etc. | Agregar `@@index([tenantId, receivedAt])` en ProcessedEmail y `@@index([tenantId, createdAt, id])` en Attachment | Listados y manifiesto de export siempre filtran por tenant primero |

Migración única: `multi_tenancy` (modelos nuevos + columnas + índices + RLS vía SQL en la misma migración con `-- RAW`).

## 3. Autenticación y autorización

| Mecanismo | Quién | Cómo |
|---|---|---|
| JWT (access 15 min + refresh 7 días, rotación) | Usuarios humanos (panel, API interactiva) | `POST /auth/login` → payload `{ sub, tenantId, role }`; argon2id para contraseñas |
| API key por tenant | `maildte-pull`, integraciones máquina | Header `X-Api-Key`; se almacena solo `sha256(key)`; formato `mdte_{tenantSlugCorto}_{random32}`; revocable |
| SUPERADMIN | LTSOFT | Usuario con `role SUPERADMIN, tenantId null`; único con acceso a `/admin/*` |

- El `ApiKeyGuard` global del MVP se reemplaza por `AuthGuard` compuesto (JWT **o** TenantApiKey) que construye el `TenantContext` (ver skill `tenancy`); la variable `API_KEY` global desaparece del `.env`.
- Roles de negocio: `ADMIN` del tenant gestiona cuentas de correo, usuarios de su tenant y API keys; `MIEMBRO` consulta y descarga.
- Errores nuevos: `TENANT_SUSPENDED` (403), `QUOTA_EXCEEDED` (422), `INVALID_CREDENTIALS` (401).

### Endpoints nuevos

```
POST   /api/v1/auth/login | /auth/refresh | /auth/logout
GET    /api/v1/me                          # usuario + tenant + plan/uso
CRUD   /api/v1/users                       # ADMIN del tenant, scoped
CRUD   /api/v1/api-keys                    # ADMIN del tenant; key visible solo al crear
--- superadmin ---
CRUD   /api/v1/admin/tenants               # alta con slug + límites de plan
POST   /api/v1/admin/tenants/:id/suspend | /activate
GET    /api/v1/admin/tenants/:id/usage     # cuentas, correos, bytes, últimos errores
POST   /api/v1/admin/tenants/:id/users     # primer ADMIN del tenant (onboarding)
```

Todos los endpoints de negocio existentes (accounts, emails, attachments, sync-logs, stats, export) quedan **automáticamente scoped** al tenant del contexto: mismas rutas, cero cambios de contrato para el cliente, solo cambia la autenticación.

## 4. Storage y export

- Nueva estructura: `{STORAGE_ROOT}/{tenantSlug}/{accountFolder}/{YYYY-MM}/{json|pdf}/` (regla y validación de traversal por tenant en skill `tenancy`).
- `relativePath` persistido incluye el `tenantSlug`.
- **Export/CLI no cambia su contrato**: la API key ahora determina el tenant, y `maildte-pull` funciona idéntico — cada cliente instala el CLI con SU key y solo ve/descarga lo suyo. La estructura local que replica incluye el nivel de cuenta pero **omite el tenantSlug** (el cliente no necesita su propio slug como carpeta raíz: `--strip-tenant-prefix` activado por defecto).

## 5. Scheduler, worker y cuotas

- Jobs con payload `{ tenantId, accountId, trigger }` y revalidación en el worker (skill `tenancy`, reglas 14–16).
- Tenant `SUSPENDIDO`: remoción de sus jobs repetibles + 403 en API de negocio; reactivación restaura todo.
- Cuotas: `maxAccounts` al crear cuenta; `maxStorageBytes` con acumulado en Redis (`usage:bytes:{tenantId}`) reconciliado contra BD al cierre de cada sync. Exceso → correos quedan registrados con `ERROR QUOTA_EXCEEDED` sin descargar archivos; al ampliar el plan, reprocesar con reset de `lastUid` los recupera (la idempotencia por messageId sigue evitando duplicados de los ya guardados).

## 6. Migración de datos existentes

Script `scripts/migrate-to-multitenant.ts` (rol de BD administrativo, una sola ejecución):

```
1. Crear tenant "ltsoft" (slug: ltsoft, límites amplios).
2. Crear usuario SUPERADMIN (email/contraseña por variables del script).
3. Crear usuario ADMIN del tenant ltsoft.
4. UPDATE email_accounts/processed_emails/attachments/sync_logs
   SET tenant_id = :ltsoftId  (transacción única).
5. Mover storage: {STORAGE_ROOT}/* → {STORAGE_ROOT}/ltsoft/*  y
   UPDATE attachments SET relative_path = 'ltsoft/' || relative_path.
6. Crear TenantApiKey "migración" para el CLI existente; imprimir la key.
7. Verificación: conteo de filas sin tenant_id = 0; sample de 20
   attachments con existsSync sobre la nueva ruta.
```

Reversible antes de confirmar (paso 5 con `rsync` a copia + swap solo tras verificación).

## 7. Impacto en fases posteriores

- **4.1 (despliegue)**: sin cambios estructurales; RUNBOOK agrega: alta de tenant (onboarding completo), suspensión, gestión de cuotas, rotación de API keys, y el procedimiento de migración anterior. `.env` cambia `API_KEY` → `JWT_SECRET`, `JWT_REFRESH_SECRET`.
- **5.1 (panel)**: login JWT (pantalla + refresh automático), selector implícito por tenant del usuario, vista de API keys, y para SUPERADMIN una sección /admin (tenants + uso). El resto del panel queda igual porque los contratos no cambiaron.
- **Skills**: instalar `tenancy`; las skills `data-layer` y `api-conventions` se leen ahora junto con `tenancy` (regla de la skill: ante conflicto, tenancy manda en lo relativo a aislamiento).

## 8. Prompts Fase 3.5

### Prompt 3.5a — Modelo, auth y contexto de tenant

```
Lee CLAUDE.md y el addendum 08 (secciones 2 y 3). Skills a aplicar:
tenancy (manda en aislamiento), data-layer, api-conventions,
testing-maildte.

1. Migración "multi_tenancy": modelos Tenant, User, TenantApiKey;
   tenantId denormalizado en EmailAccount, ProcessedEmail, Attachment,
   SyncLog; cambios de constraints e índices de la tabla de la
   sección 2 (el unique [accountId, messageId] NO se toca); RLS con
   FORCE en las 6 tablas con la policy de la skill tenancy (SQL raw
   dentro de la migración).
2. PrismaService.withTenant(tenantId, fn) con set_config SET LOCAL
   según la skill.
3. Módulo auth: login/refresh/logout con JWT (access 15 min, refresh
   7 días con rotación), argon2id, y AuthGuard compuesto JWT |
   TenantApiKey que construye TenantContext y reemplaza al ApiKeyGuard
   global (eliminar API_KEY del env; agregar JWT_SECRET y
   JWT_REFRESH_SECRET a la validación Joi). Decoradores @Public(),
   @Roles(), @CurrentTenant().
4. Módulos users y api-keys scoped al tenant (ADMIN); la API key en
   claro solo en la respuesta de creación, formato
   mdte_{slug8}_{random32}, almacenada como sha256.
5. Módulo admin (/admin/*, solo SUPERADMIN): CRUD tenants con slug
   inmutable, suspend/activate (remueve/restaura jobs repetibles),
   usage, alta del primer ADMIN.
6. Semilla: scripts/seed-superadmin.ts idempotente.
	pnpm run seed:superadmin (idempotente)

Tests: login ok/fail, refresh con rotación, API key revocada → 401,
MIEMBRO no puede crear cuentas de correo, /admin con ADMIN normal →
403, y los dos primeros casos del checklist de aislamiento de la
skill tenancy.
```

### Prompt 3.5b — Scoping integral, storage por tenant y migración

```
Lee CLAUDE.md y el addendum 08 (secciones 4, 5 y 6). Skills:
tenancy, atomic-storage, queues-worker, data-layer, testing-maildte.

1. Refactor de TODOS los services de negocio (accounts, sync, emails,
   stats, export): TenantContext como primer parámetro, scoping
   explícito con tenantId en cada where/create según la skill tenancy
   (findFirst en accesos por id, 404 cross-tenant), y withTenant en
   las transacciones de escritura del sync.
2. StorageService: nueva raíz por tenantSlug, resolveSafe validando
   dentro del slug del contexto, relativePath con slug incluido.
3. Scheduler/worker: payload { tenantId, accountId, trigger },
   revalidación de pertenencia y estado ACTIVO del tenant al iniciar
   cada job; suspensión remueve repetibles (reusar el mecanismo de
   ERROR_AUTH).
4. Cuotas: maxAccounts al crear cuenta (422 QUOTA_EXCEEDED);
   maxStorageBytes con contador Redis usage:bytes:{tenantId}
   incrementado por adjunto guardado y reconciliado contra BD al
   cerrar cada SyncLog; exceso → correo ERROR QUOTA_EXCEEDED sin
   descarga, el sync continúa.
5. Export/CLI: manifest y archive scoped por el tenant de la key;
   en maildte-pull agregar --strip-tenant-prefix (default true) que
   omite el primer segmento del relativePath al escribir localmente.
6. scripts/migrate-to-multitenant.ts según la sección 6 del addendum,
   con verificación y salida detallada.

Tests: checklist de aislamiento COMPLETO de la skill tenancy
(sembrando tenants A y B), cuota de storage excedida deja ERROR y el
sync continúa, y e2e de RLS: query con withTenant(A) no ve filas de B
y sin set_config ve 0 filas.

Aceptación: dos tenants con una cuenta de correo cada uno sincronizan
en paralelo; con el login del tenant A es imposible ver, listar,
descargar o exportar nada del tenant B por ninguna ruta; el CLI con
la key de A replica solo la estructura de A sin el prefijo de slug.
```

## 9. Estimación

| Ítem | Duración |
|---|---|
| 3.5a — Modelo + auth | 1.5 días |
| 3.5b — Scoping + storage + migración | 1.5–2 días |
| Delta en 4.1 y 5.1 | +0.5 día |
| **Total del addendum** | **3.5–4 días** (MVP multi-tenant completo: ~10–11.5 días) |

## 10. Orden de ejecución actualizado

```
0.1 → 1.1 → 2.1 → 2.2 → 3.1 → 3.2  (ya ejecutados / en curso)
→ 3.5a → 3.5b                      (este addendum)
→ 4.1 (con deltas de la sección 7)
→ 5.1 / 5.2 (opcionales, sobre el modelo final)
```
