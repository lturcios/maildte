# Addendum 09 — Perfiles de servicio de correo (catálogo maestro IMAP)

Estado: **plan aprobado, pendiente de implementación**
Depende de: `03-ARQUITECTURA-TECNICA.md`, `08-ADDENDUM-MULTITENANT.md`
Fecha de decisión: 2026-09-01

---

## 1. Problema

Hoy cada cuenta IMAP (`RF-01`) obliga al ADMIN del tenant a escribir a mano `imapHost`,
`imapPort` e `imapSecure`. Son datos que el cliente no conoce, que copia mal, y que se
repiten idénticos entre todos los tenants que usan el mismo proveedor.

## 2. Objetivo

Un catálogo maestro global, administrado por SUPERADMIN, con los parámetros de conexión
de los servicios de correo conocidos. El alta de cuenta:

1. **Infiere** el proveedor a partir del dominio del correo.
2. Permite **cambiarlo** desde una lista desplegable.
3. **Advierte** si el usuario cambia un proveedor detectado sobre un dominio obvio
   (gmail.com, outlook.com…).
4. Mantiene la opción de **servidor personalizado** para proveedores fuera del catálogo.

---

## 3. Decisiones de arquitectura

### ADR-09.1 — Referencia viva (join), no snapshot

`EmailAccount.providerId` es la **única fuente de verdad** de host/puerto/TLS cuando está
presente. El sync resuelve la configuración por la relación en cada corrida.

**Consecuencia aceptada explícitamente:** editar un perfil impacta en caliente a todas las
cuentas vinculadas, de todos los tenants. Un error del SUPERADMIN es un incidente
multi-tenant.

**Mitigaciones obligatorias** (no opcionales, son la contrapartida de esta decisión):

- `onDelete: Restrict` en la FK — un perfil en uso no se puede borrar.
- `PATCH` que modifique `imapHost` / `imapPort` / `imapSecure` sobre un perfil en uso exige
  `confirmAffectedAccounts: <N>` en el body; si el número no coincide con el conteo real,
  responde `409`. Patrón "escribí el nombre para confirmar" de GitHub.
- `POST /admin/mail-providers/:id/probe` — verificación TCP/TLS del endpoint antes de
  guardar. No valida credenciales (el perfil no las tiene), pero descarta el typo.
- Todo cambio de endpoint se loguea con pino incluyendo el `userId` del actor y el conteo de
  cuentas afectadas.
- El campo `active: false` **oculta** el perfil del desplegable sin desvincular las cuentas
  existentes. Es el mecanismo de retiro, no el DELETE.

### ADR-09.2 — `providerId` nullable: null significa "servidor personalizado"

No todos los servidores pueden estar en un catálogo público: un cPanel de un hosting local
(`mail.empresa.com.sv`) es específico de un cliente y no tiene sentido publicarlo a todos
los tenants.

- `providerId != null` → el sync usa `provider.imapHost/Port/Secure`.
- `providerId == null` → el sync usa las columnas propias de `EmailAccount`.

Las columnas `imapHost/imapPort/imapSecure` **se conservan en `EmailAccount`** para este
camino. No se borran. Esto además hace la migración no destructiva: las cuentas existentes
que no matcheen ningún perfil quedan como personalizadas y siguen funcionando igual.

Alternativa descartada: perfiles privados por tenant. Agrega `tenantId` + RLS a la tabla de
catálogo y duplica la UI, sin beneficio real sobre el camino "personalizado".

### ADR-09.3 — Detección: tabla de dominios primero, MX como fallback

1. **Match exacto** de dominio contra `mail_provider_domains` (kind `DOMAIN`).
2. Si no hay match, **consulta MX** con `dns.promises.resolveMx` (Node nativo, sin
   dependencia nueva) y se compara el exchange de menor prioridad contra las filas
   `kind = MX_SUFFIX`.

El paso 2 es el que importa de verdad: en El Salvador la mayoría de las PYMEs usan dominio
propio sobre Google Workspace o Microsoft 365. Sin MX lookup, la detección falla justo en el
caso de uso principal.

Restricciones del MX lookup:

- Timeout duro de 3 s (`Promise.race`). Un DNS colgado **no** puede bloquear el alta.
- Falla siempre en silencio hacia `null` — la detección es una ayuda, nunca un requisito.
- Resultado cacheado en Redis 24 h, clave `mxprovider:{domain}`.
- **Gotcha crítico:** los MX de gateways de filtrado (`pphosted.com`, `mimecast.com`,
  `barracudanetworks.com`, `messagelabs.com`) **no indican dónde está el IMAP real**.
  Nunca se registran como `MX_SUFFIX`; producirían un falso positivo peligroso.

Autoconfig de Thunderbird / Autodiscover queda **fuera de alcance** (fase 2): mete una
dependencia HTTP externa en el camino del alta de cuenta.

---

## 4. Esquema

```prisma
enum DomainMatchKind {
  DOMAIN      // dominio del correo: gmail.com
  MX_SUFFIX   // sufijo del registro MX: google.com
}

model MailProvider {
  id             String   @id @default(uuid())
  key            String   @unique          // "gmail", "microsoft365"
  name           String                    // "Gmail / Google Workspace"
  imapHost       String
  imapPort       Int      @default(993)
  imapSecure     Boolean  @default(true)
  defaultMailbox String   @default("INBOX")
  /** Dominio obvio: advertir si el usuario cambia el perfil detectado. */
  strict         Boolean  @default(false)
  /** Requisitos de autenticación en lenguaje del usuario (app password, etc.). */
  notes          String?
  helpUrl        String?
  /** false = oculto del desplegable; NO desvincula cuentas existentes. */
  active         Boolean  @default(true)
  sortOrder      Int      @default(100)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  domains  MailProviderDomain[]
  accounts EmailAccount[]

  @@map("mail_providers")
}

model MailProviderDomain {
  id         String          @id @default(uuid())
  providerId String
  provider   MailProvider    @relation(fields: [providerId], references: [id], onDelete: Cascade)
  domain     String
  kind       DomainMatchKind @default(DOMAIN)
  createdAt  DateTime        @default(now())

  // outlook.com existe como dominio de correo Y como sufijo MX de M365:
  // la unicidad es por (kind, domain), no por domain solo.
  @@unique([kind, domain])
  @@index([providerId])
  @@map("mail_provider_domains")
}

model EmailAccount {
  // ... campos existentes sin cambios ...
  providerId String?
  provider   MailProvider? @relation(fields: [providerId], references: [id], onDelete: Restrict)

  @@index([providerId])
}
```

### RLS

`mail_providers` y `mail_provider_domains` son **catálogo global sin `tenantId`**. La
migración **no** les habilita RLS: sin policy, la tabla queda sin restricción y se lee
correctamente dentro de las transacciones de `PrismaService.withTenant()`. La escritura se
restringe en la capa de aplicación con `@Roles(Role.SUPERADMIN)`.

Esto debe quedar comentado explícitamente en el SQL de la migración, porque contradice a
simple vista la regla de RLS FORCE de las 6 tablas de negocio.

---

## 5. Resolución de credenciales — un solo lugar

Mismo principio que `StorageService.resolveMonthFolder()` (regla 7 de `CLAUDE.md`): la
lógica de "de dónde sale el endpoint" vive en **una** función.

`src/sync/imap/resolve-imap-endpoint.ts`

```ts
export type AccountWithProvider = EmailAccount & { provider: MailProvider | null };

export interface ImapEndpoint {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

/** providerId presente -> manda el perfil; null -> mandan las columnas de la cuenta. */
export function resolveImapEndpoint(account: AccountWithProvider): ImapEndpoint;
```

Consumidores (todos pasan por acá, ninguno lee `account.imapHost` directo):

| Archivo | Cambio |
|---|---|
| `src/sync/sync.service.ts:121` | agregar `include: { provider: true }` al `findFirst` |
| `src/sync/sync.service.ts:171` | `syncMailbox` recibe `AccountWithProvider`; credenciales vía `resolveImapEndpoint` |
| `src/accounts/accounts.service.ts` `create` | resolver desde el DTO antes de `verifyOrThrow` |
| `src/accounts/accounts.service.ts` `update` | idem, mezclando DTO + fila existente |
| `src/accounts/accounts.service.ts` `testConnection` | cargar con `include` y resolver |
| `SAFE_ACCOUNT_SELECT` | agregar `providerId` + `provider` (select anidado, sin campos sensibles) |

`src/sync/sync-bootstrap.service.ts:36` solo usa `id` e `interval`: **no** requiere cambios.

---

## 6. API

| Método | Ruta | Rol | Notas |
|---|---|---|---|
| `GET` | `/mail-providers` | autenticado | catálogo `active: true` con dominios |
| `GET` | `/mail-providers/resolve?email=` | autenticado | `{ provider, source: 'DOMAIN' \| 'MX' \| null }` |
| `POST` | `/admin/mail-providers` | SUPERADMIN | |
| `PATCH` | `/admin/mail-providers/:id` | SUPERADMIN | `confirmAffectedAccounts` si cambia el endpoint |
| `DELETE` | `/admin/mail-providers/:id` | SUPERADMIN | `409` si está en uso (FK Restrict) |
| `POST` | `/admin/mail-providers/:id/probe` | SUPERADMIN | reachability TCP/TLS |
| `GET` | `/admin/mail-providers/:id/usage` | SUPERADMIN | `{ accounts, tenants }` |

`CreateAccountDto` / `UpdateAccountDto`: `providerId?: string` (UUID). Cuando viene
`providerId`, `imapHost/imapPort/imapSecure` pasan a ser opcionales e ignorados; cuando no
viene, siguen siendo requeridos como hoy. La validación cruzada va en el service, no en el
DTO (`422 PROVIDER_NOT_FOUND` si el UUID no existe o está inactivo).

---

## 7. Catálogo semilla

Script idempotente de mantenimiento (`prisma/seed-mail-providers.ts`, upsert por `key`), no
datos embebidos en la migración: así se pueden agregar proveedores nuevos re-ejecutándolo.

| key | host | puerto | strict | requisito de auth |
|---|---|---|---|---|
| `gmail` | `imap.gmail.com` | 993 | sí | App Password (2FA obligatorio) |
| `microsoft365` | `outlook.office365.com` | 993 | sí | **ver riesgo §9** |
| `yahoo` | `imap.mail.yahoo.com` | 993 | sí | App Password |
| `icloud` | `imap.mail.me.com` | 993 | sí | App Password |
| `zoho` | `imap.zoho.com` | 993 | no | App Password si hay 2FA |
| `godaddy` | `imap.secureserver.net` | 993 | no | — |
| `namecheap` | `mail.privateemail.com` | 993 | no | — |
| `hostinger` | `imap.hostinger.com` | 993 | no | — |
| `rackspace` | `secure.emailsrvr.com` | 993 | no | — |
| `aws-workmail` | `imap.mail.{region}.awsapps.com` | 993 | no | región variable |

Sufijos MX asociados: `google.com`/`googlemail.com` → `gmail`;
`mail.protection.outlook.com` → `microsoft365`; `zoho.com`/`zoho.eu` → `zoho`;
`secureserver.net` → `godaddy`; `privateemail.com` → `namecheap`;
`emailsrvr.com` → `rackspace`; `awsapps.com` → `aws-workmail`.

**Pendiente de investigación con datos reales:** proveedores locales de El Salvador
(Claro, Tigo, Movistar) y los hostings usados por las PYMEs salvadoreñas. No se siembran
valores sin verificar contra una cuenta real.

**Excluido a propósito:** Proton (requiere Bridge en localhost, inviable desde un servidor).

### Backfill de cuentas existentes

Paso posterior al seed: match case-insensitive de `EmailAccount.imapHost` contra
`MailProvider.imapHost` → setea `providerId`. Sin match, queda `null` (personalizada).
Cero pérdida de funcionalidad.

---

## 8. Frontend

**`AccountFormDialog.tsx`** — reemplazar los tres inputs de conexión por:

- `<Select>` de proveedor + opción `Servidor personalizado (avanzado)` que revela
  host/puerto/TLS.
- `onBlur` del campo correo → `GET /mail-providers/resolve` → autoselección, con leyenda
  `Detectado por dominio` o `Detectado por registro MX`.
- Si el usuario cambia un proveedor detectado con `strict: true` → banner de advertencia
  ámbar, **no bloqueante**.
- Mostrar `notes` + `helpUrl` del proveedor elegido. Acá se evita la mayor parte de los
  tickets de "no me conecta".

**`ServiciosCorreoPage.tsx`** (nueva, bajo `SuperadminRoute`) + `mail-providers-store.ts` +
ítem de navegación. CRUD de perfiles y dominios, botón "Probar host", badge
`N cuentas en uso`, y el diálogo de confirmación con el conteo para editar el endpoint.

**`types/domain.ts`** — `MailProvider`, `MailProviderDomain`, `ResolveProviderResult`;
`SafeAccount` gana `providerId` y `provider`.

---

## 9. Riesgo abierto: la autenticación, no el host

El perfil resuelve host y puerto, pero **no** resuelve el problema real que enfrenta el
usuario final:

- **Gmail** con 2FA rechaza la contraseña normal; exige App Password.
- **Microsoft 365 / Outlook / Hotmail**: Microsoft viene retirando basic auth en IMAP a
  favor de OAuth2. **Antes de publicar el perfil `microsoft365` hay que validarlo contra una
  cuenta real.** Si basic auth ya no funciona, ese perfil va a fallar siempre y va a parecer
  un bug del sistema, no una política de Microsoft.

Por eso `notes` y `helpUrl` son parte del modelo desde el día uno. OAuth2 por proveedor es
un addendum aparte, no entra acá.

---

## 10. Fases

| # | Alcance | Entregable | Estado |
|---|---|---|---|
| F1 | Schema + migración + seed + `resolveImapEndpoint` + sync | El sync lee por join, tests verdes | **hecha y aplicada** |
| F2 | Módulo `mail-providers`: API pública + admin | Endpoints §6 | **hecha** |
| F3 | Detección: dominio + MX + caché Redis | `GET /resolve` | **hecha** |
| F4 | `AccountFormDialog` con desplegable, detección y advertencia | Alta sin escribir host | **hecha** |
| F5 | `ServiciosCorreoPage` (SUPERADMIN) | CRUD de perfiles | **hecha** |
| F6 | Tests + actualización de `02-SRS` y `03-ARQUITECTURA` | DoD de `CLAUDE.md` | **hecha** |

### F1 — qué quedó implementado

- `prisma/schema.prisma`: enum `DomainMatchKind`, modelos `MailProvider` y
  `MailProviderDomain`, `EmailAccount.providerId` nullable con `onDelete: Restrict`.
- `prisma/migrations/20260901120000_mail_providers/migration.sql`, escrita a mano
  siguiendo el estilo de `multi_tenancy` (Docker no estaba levantado). **Todavía
  no se aplicó contra ninguna base**: correr `pnpm prisma migrate dev` con
  Postgres arriba. Si Prisma reportara drift, la migración a mano no coincide con
  el schema y hay que regenerarla.
- `src/sync/imap/resolve-imap-endpoint.ts` + spec: `pickImapEndpoint` /
  `resolveImapEndpoint`, el único lugar donde se decide el endpoint efectivo.
- `src/sync/sync.service.ts`: `include: { provider: true }` en la carga de la
  cuenta (línea única) y `syncMailbox` tipada como `AccountWithProvider`.
- `src/accounts/`: DTOs con `providerId` (create opcional, update con la
  distinción ausente/UUID/null), `resolveWriteEndpoint` privado con los 422
  `PROVIDER_NOT_FOUND` / `IMAP_ENDPOINT_REQUIRED`, `SAFE_ACCOUNT_SELECT` con el
  perfil anidado, y `testConnection` probando el endpoint efectivo.
- `scripts/seed-mail-providers.ts` + `pnpm run seed:mail-providers`, idempotente,
  con `--link-existing` como flag explícito de mantenimiento.
- 9 tests nuevos de perfil (create/update) + 7 del resolver. Suite completa:
  121/121, `pnpm build` y `pnpm lint` limpios.

Migración aplicada y semilla ejecutada contra el Postgres local: 9 perfiles,
26 dominios. Sin drift reportado por Prisma.

### F2 — qué quedó implementado

Módulo `src/mail-providers/`:

- `mail-providers.service.ts` — CRUD del catálogo, `usage()`, `probe()`, y el
  blindaje de la edición en caliente.
- `mail-providers.controller.ts` — `GET /mail-providers`, sin `@Roles`:
  cualquier usuario autenticado lee el catálogo activo.
- `admin-mail-providers.controller.ts` — `@Roles(SUPERADMIN)` a nivel de clase,
  con todos los endpoints de la §6.
- `imap-probe.ts` (+ spec) — socket crudo TCP/TLS que espera el saludo del
  servidor. **No** acepta "puerto abierto" como éxito: exige un saludo
  `* OK` / `* PREAUTH` (RFC 3501 §7.1), porque un puerto que responde cualquier
  otra cosa dejaría el perfil roto igual.
- DTOs con `key` inmutable (la semilla hace upsert por esa clave) y `domains`
  con semántica de reemplazo total cuando viene presente.

**Verificado empíricamente contra la base** (esto sostiene la §4 de la
migración): `pg_tables.rowsecurity` es `false` en `mail_providers` y
`mail_provider_domains`, y `true` en las 6 tablas de negocio. Con `SET ROLE
maildte_app` y sin tenant en contexto, el rol ve los 9 perfiles y **0**
`email_accounts`.

Ese `0` es exactamente por qué `usage()` recorre los tenants con `withTenant()`
en vez de hacer un `count` directo: un conteo ingenuo habría devuelto siempre
cero, y el SUPERADMIN habría podido borrar un perfil en uso o cambiarle el host
sin que saltara ninguna confirmación. Es N+1 a propósito, con N = cantidad de
organizaciones, sobre endpoints que no están en ningún camino caliente.

Suite: 143/143, `pnpm build` y `pnpm lint` limpios. Smoke test con la API
levantada: `/api/v1/health` 200, `/api/v1/mail-providers` y
`/api/v1/admin/mail-providers` 401 (rutas registradas, guard activo).

### F3 — qué quedó implementado

- `mx-lookup.ts` (+ spec) — `lookupMxExchanges` (Resolver de `dns/promises` con
  `timeout` + `Promise.race` como techo duro; nunca lanza, devuelve `[]`),
  `matchesMxSuffix` y `domainOfEmail`.
- `MailProvidersService.resolveByEmail()` — dominio exacto primero, MX después.
- `GET /mail-providers/resolve?email=` — devuelve `{ provider, source }` con
  `source` en `'DOMAIN' | 'MX' | null`.
- Caché en Redis con clave `mx:{dominio}`.

Decisiones que importan:

- **Se cachea la respuesta DNS, no el perfil resuelto.** Si el SUPERADMIN agrega
  un sufijo MX al catálogo, el match se recalcula al instante en vez de quedar
  congelado 24 h. Lo caro y externo es el DNS; el match por sufijo es en memoria.
- **TTL asimétrico**: 24 h para un resultado con MX, 1 h para el vacío. Un
  cliente que acaba de configurar su dominio no queda sin detección un día
  entero.
- **El match de sufijo exige el punto de separación**: `notgoogle.com` NO
  matchea `google.com`. Sin esa guarda se mandarían las credenciales del cliente
  al servidor equivocado. Hay test.
- **Redis caído no rompe nada**: se cae a la consulta DNS directa. Hay test.
- Toda la detección es una SUGERENCIA: cualquier error termina en
  `{ provider: null, source: null }` y el usuario carga los datos a mano.

Verificado contra DNS real:

| dominio | MX principal | detectado |
|---|---|---|
| `gmail.com` | `gmail-smtp-in.l.google.com` | `google.com` |
| `anthropic.com` | `aspmx.l.google.com` | `google.com` |
| `microsoft.com` | `microsoft-com.mail.protection.outlook.com` | `mail.protection.outlook.com` |
| `ltsoft.us` | `mail.ltsoft.us` | sin match → servidor personalizado |

`anthropic.com` es el caso de uso central: dominio propio con Workspace detrás,
indetectable sin el MX lookup. `ltsoft.us` confirma que el camino de
`providerId` NULL (ADR-09.2) es necesario y no un adorno.

Suite: 166/166. Smoke test: `/api/v1/mail-providers/resolve` responde 401
(ruta registrada, sin colisión con el listado).

### F4 — qué quedó implementado

- `web/src/types/domain.ts` — `MailProvider`, `AccountMailProvider`,
  `MailProviderDomain`, `ResolveProviderResult`; `SafeAccount` con `providerId`
  y `provider`; `providerId` en los inputs de alta y edición.
- `web/src/stores/mail-providers-store.ts` — catálogo cacheado, mismo patrón que
  `accounts-store`.
- `web/src/lib/imap-endpoint.ts` — `resolveAccountEndpoint()` /
  `formatAccountEndpoint()`, **espejo en el frontend del resolver del backend**.
  Ninguna vista debe leer `account.imapHost` directo.
- `web/src/components/accounts/AccountFormDialog.tsx` — desplegable de servicio,
  detección al salir del campo de correo, advertencia ámbar, resumen del
  endpoint del perfil con `notes` y `helpUrl`.
- `web/src/pages/CuentasPage.tsx` — la columna de servidor pasa por
  `formatAccountEndpoint()` y muestra el nombre del perfil.

Decisiones de UX que importan:

- **La detección sugiere, no impone.** Se aplica sola mientras el usuario no
  haya tocado el desplegable (`providerTouched`); a partir de ahí manda su
  elección y la detección solo alimenta la advertencia.
- **La advertencia de perfil `strict` no bloquea.** Puede haber un caso legítimo;
  el usuario tiene que enterarse, no ser frenado.
- **Con perfil elegido se ocultan host/puerto/TLS** y se muestra el endpoint del
  catálogo como dato de solo lectura, con la leyenda de que lo administra el
  proveedor del sistema y se aplica en la siguiente sincronización.
- **Bug corregido durante F4**: `CuentasPage` mostraba `account.imapHost`, que
  con un perfil vinculado es la última columna escrita y no lo que usa el sync.
  De ahí salió `imap-endpoint.ts`.
- **Caso del perfil deshabilitado**: si el SUPERADMIN deshabilita un perfil que
  una cuenta usa, el catálogo activo ya no lo trae. El diálogo lo recupera de
  `account.provider` para ofrecerlo igual en el desplegable y avisar; sin eso el
  select quedaba vacío y se mostraban los campos de servidor manual para una
  cuenta que en realidad usa un perfil.

Verificado contra la base y el DNS reales, instanciando el service directo:

| correo | source | perfil | host |
|---|---|---|---|
| `x@gmail.com` | `DOMAIN` | gmail | `imap.gmail.com` |
| `x@anthropic.com` | `MX` | gmail | `imap.gmail.com` |
| `x@microsoft.com` | `MX` | microsoft365 | `outlook.office365.com` |
| `x@ltsoft.us` | `null` | — | servidor personalizado |

La forma del JSON devuelto coincide campo por campo con la interfaz
`MailProvider` del frontend. `web`: `tsc -b`, `pnpm lint` y `pnpm build`
limpios. Backend sin regresiones: 166/166.

### F5 — qué quedó implementado

Backend (mejora necesaria para que la pantalla no se degrade):

- `MailProvidersService.usageAll()` — uso de **todos** los perfiles agrupando por
  `providerId` dentro de cada tenant: **2 consultas por organización**, en vez de
  2 × perfiles × organizaciones que habría costado pedir el uso fila por fila.
- `usage(id)` ahora delega en `usageAll()`: una sola implementación del
  recorrido, así el conteo del guard de edición y el de la pantalla no pueden
  divergir.
- `GET /admin/mail-providers/usage`, declarado **antes** de `@Get(':id')`.
  Verificado en el log de arranque de Nest: `usage` se mapea antes que `:id`.

Frontend:

- `web/src/stores/admin-mail-providers-store.ts` — catálogo completo (incluye
  deshabilitados) + mapa de uso.
- `web/src/components/mail-providers/MailProviderFormDialog.tsx` — alta/edición,
  editor de dominios con su `kind`, y la confirmación tipeada.
- `web/src/pages/ServiciosCorreoPage.tsx` — tabla con servidor, dominios, estado,
  uso, y acciones probar / editar / eliminar.
- `web/src/components/ui/textarea.tsx` — faltaba en el design system.
- Ruta `/servicios-correo` bajo `SuperadminRoute` + ítem de navegación.

Decisiones que importan:

- **La confirmación se pide en el formulario, no después del error.** El diálogo
  ya conoce el conteo, así que muestra "N cuentas de M organizaciones" y exige
  escribir N antes de habilitar Guardar. El backend igual revalida por su
  cuenta: si el número cambió entre que se abrió el diálogo y el guardado, el
  409 aparece como toast.
- **El botón Eliminar queda deshabilitado si el perfil está en uso**, y el
  diálogo explica el caso contraintuitivo de las cuentas con soft delete, además
  de sugerir la alternativa correcta (deshabilitar en vez de borrar).
- **Guardar invalida el catálogo público cacheado** (`useMailProvidersStore`), o
  el desplegable del alta de cuentas mostraría datos viejos en la misma sesión.
- El editor de dominios **descarta las filas vacías** en vez de rebotar el
  guardado: agregar una fila y no completarla es un accidente común.
- La ayuda del editor advierte explícitamente contra cargar MX de filtros
  antispam como `pphosted.com`.

`web`: `tsc -b`, `pnpm lint` y `pnpm build` limpios. Backend: 168/168, lint y
build limpios.

Nota menor: `mx-lookup.spec.ts` hace consultas DNS reales (dominio `.invalid` y
un timeout de 1 ms). En una corrida apareció un aviso de worker forzado a
salir; no se reprodujo en tres corridas siguientes y cada suite pasa limpia con
`--detectOpenHandles`. Si reaparece en CI, el sospechoso es ese archivo.

### F6 — documentación, verificación en navegador y un bug encontrado

**Documentación**: `02-SRS` suma RF-01.6/7/8 y el bloque RF-09 completo;
`03-ARQUITECTURA` suma ADR-09.1/09.2/09.3 y tres notas de diseño de BD (por qué
el catálogo no lleva RLS, por qué contar a través de tenants exige recorrerlos,
y el comportamiento de `current_setting` de la sección siguiente). `RUNBOOK`
suma la sección **2.b** con el procedimiento completo de despliegue,
verificación post-despliegue y rollback.

#### Verificación en navegador (Playwright, superadmin temporal)

Se creó un SUPERADMIN, un tenant y una cuenta de prueba, se recorrió el panel y
después se borró todo (base final: 0 usuarios, 0 tenants, 0 cuentas; el catálogo
sembrado queda). Verificado en vivo:

- La pantalla lista los 9 perfiles con servidor, dominios, estado y uso.
- **Probe contra servidores IMAP reales**, con TLS y verificación de certificado:
  `imap.gmail.com` → `* OK Gimap ready` (262 ms), `outlook.office365.com` →
  `* OK Microsoft Exchange IMAP4 service ready` (371 ms), `imap.zoho.com` →
  `* OK svwall.zoho.com IMAP4 Server` (440 ms).
- Con una cuenta vinculada, la tabla mostró **"1 cuenta(s), 1 organización(es)"**:
  el conteo cross-tenant a través del RLS funciona en vivo.
- Al cambiar el host, apareció la confirmación con el texto exacto y **Guardar
  quedó deshabilitado**; con un número equivocado siguió deshabilitado; con el
  correcto se habilitó. El backend rechaza igual por su cuenta.
- El borrado de un perfil en uso explica el motivo y deja el botón inhabilitado.
- **Alta de cuenta con `facturacion@anthropic.com`** (dominio propio, sin ninguna
  pista textual de Google): autoseleccionó *Gmail / Google Workspace* con la
  leyenda "Detectado automáticamente por el registro MX del dominio", mostró el
  endpoint de solo lectura, las notas de contraseña de aplicación y el enlace de
  ayuda, **sin ningún campo de servidor**.
- Al cambiar ese perfil por Zoho, saltó la advertencia ámbar sin bloquear.
- La tabla de cuentas muestra el endpoint efectivo más el nombre del perfil.

#### Bug preexistente encontrado y corregido

La verificación destapó un 500 intermitente en el **login de SUPERADMIN**, ajeno
a este addendum: las policies de RLS de `users` identificaban al SUPERADMIN con
`current_setting('app.tenant_id', true) IS NULL`. Postgres, al terminar una
transacción que usó `set_config(..., true)`, **no elimina la GUC: la deja en
string vacío**. Como Prisma usa un pool, cualquier conexión que ya hubiera
servido a un tenant dejaba de ver la fila del SUPERADMIN para `UPDATE`.

Comprobado en la base:

```sql
-- conexión nueva
SELECT current_setting('app.tenant_id', true) IS NULL;  --> true
BEGIN; SELECT set_config('app.tenant_id','x',true); COMMIT;
SELECT current_setting('app.tenant_id', true) IS NULL;  --> false
SELECT current_setting('app.tenant_id', true) = '';     --> true
```

No era un agujero de seguridad: fallaba **cerrado**. Las policies
`tenant_isolation` comparan `"tenantId" = <guc>`, que con string vacío da falso
y devuelve cero filas — correcto, sin cambios.

Fix: migración `20260902000000_fix_superadmin_rls_null_tenant`, que envuelve la
GUC en `nullif(..., '')` en las 3 policies de escritura de `users`. Se verificó
que el aislamiento no se debilita: desde un tenant real, un `UPDATE` sobre la
fila del SUPERADMIN sigue dando `UPDATE 0`.

**Este addendum no causó el bug, pero lo volvió mucho más alcanzable**:
`usageAll()` corre transacciones `withTenant` desde una pantalla de SUPERADMIN,
que antes no existía.

Regresión cubierta en `test/auth.e2e-spec.ts` (no se puede con un unit test: es
comportamiento del motor). **Se comprobó que el test falla con la policy vieja
restaurada**, y vuelve a pasar con el fix.

#### Estado final

- Unit: **168/168**. `pnpm build` y `pnpm lint` limpios.
- E2E: **40/40**.
- `web`: `tsc -b`, `pnpm lint` y `pnpm build` limpios.

#### Flakiness del arnés e2e, diagnosticada y corregida

La suite e2e fallaba de forma intermitente (aproximadamente 1 de cada 4
corridas), en suites distintas cada vez. La primera hipótesis —contención por
paralelismo— **era incorrecta**: también fallaba con `--runInBand`.

La causa real es que el `beforeAll` de cada suite levanta una app Nest completa
(`Test.createTestingModule({ imports: [AppModule] }).compile()` + `app.init()`),
y con la máquina cargada eso supera el **timeout por defecto de Jest de 5000 ms
para un hook**. El error lo decía textualmente:

```
thrown: "Exceeded timeout of 5000 ms for a hook."
  at test/auth.e2e-spec.ts:12:3   <-- el beforeAll
```

Es preexistente y ajeno a este addendum. Se agregó `"testTimeout": 30000` a
`test/jest-e2e.json`: no cambia ninguna aserción, solo le da al arranque de la
app el margen que necesita. Cinco corridas seguidas en verde después del cambio.

Importa más de lo que parece: con el arnés flakeando, el test de regresión del
bug de RLS no sería confiable.

## 11. Tests obligatorios (regla 26)

- `resolveImapEndpoint`: `providerId` seteado gana el perfil; `null` gana la cuenta.
- Detección: dominio exacto; vía MX; MX de gateway de filtrado → `null`; timeout de DNS →
  `null` sin excepción.
- `DELETE` de perfil en uso → `409`.
- `PATCH` de endpoint sin `confirmAffectedAccounts` correcto → `409`.
- Alta con `providerId` inexistente o inactivo → `422`.
- Aislamiento: un ADMIN de tenant no puede crear ni editar perfiles (`403`).
