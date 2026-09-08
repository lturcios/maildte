# RUNBOOK — MailDTE Collector

Procedimientos operativos para el despliegue en VPS. Este documento asume que ya
corriste el despliegue inicial (sección 1) y que tenés acceso SSH al VPS con
permiso para usar `docker`.

Todos los ejemplos de `curl` asumen `API=https://TUDOMINIO/api/v1` y que ya
tenés un token de acceso (`TOKEN`) obtenido con `POST /auth/login` (sección 3).

---

## 1. Despliegue inicial

1. Cloná el repositorio en el VPS (`/opt/maildte` en los ejemplos de acá).
2. Creá el archivo `.env` junto a `docker-compose.prod.yml` con estas variables
   (generá `ENCRYPTION_KEY`, `JWT_SECRET` y `JWT_REFRESH_SECRET` con
   `openssl rand -hex 32` — usá valores **distintos** para cada una):

   ```env
   NODE_ENV=production
   PORT=3000
   DB_PASSWORD=<contraseña de Postgres>
   DATABASE_URL=postgresql://maildte:<DB_PASSWORD>@postgres:5432/maildte
   APP_DATABASE_URL=postgresql://maildte_app:<otra-contraseña>@postgres:5432/maildte
   REDIS_URL=redis://redis:6379
   ENCRYPTION_KEY=<openssl rand -hex 32>
   JWT_SECRET=<openssl rand -hex 32>
   JWT_REFRESH_SECRET=<openssl rand -hex 32>
   STORAGE_ROOT=/data/storage
   DEFAULT_SYNC_INTERVAL=300
   TZ_FOLDER=America/El_Salvador
   LOG_LEVEL=info
   MAX_ATTACHMENT_MB=25
   EXPORT_MAX_ZIP_FILES=5000
   PURCHASE_BOOK_EXPORT_MAX_ROWS=20000
   PURCHASE_BOOK_REPROCESS_BATCH=1000
   DTE_MAX_JSON_BYTES=2097152
   DTE_QUEUE_CONCURRENCY=4
   ```

   Las cuatro últimas son del libro de compras (Addendum 10) y tienen valores
   por defecto razonables: se pueden omitir del `.env` salvo que haya que
   ajustarlas. Ver la sección 9.

   `APP_DATABASE_URL` apunta al rol restringido `maildte_app` — ese rol lo crea
   automáticamente la migración `multi_tenancy` la primera vez que corre
   `prisma migrate deploy` (ver el comentario en esa migración), con la
   contraseña de desarrollo `maildte_app_dev_only` **hardcodeada**. Antes de ir
   a producción, cambiala:

   ```bash
   docker compose -f docker-compose.prod.yml exec postgres \
     psql -U maildte -d maildte -c "ALTER ROLE maildte_app WITH PASSWORD '<otra-contraseña>';"
   ```

   y usá esa misma contraseña en `APP_DATABASE_URL`.

3. Levantá todo:

   ```bash
   cd /opt/maildte
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml logs -f api   # confirmar que migrate deploy corrió OK
   curl -s http://127.0.0.1:3000/api/v1/health             # {"data":{"status":"ok",...}}
   ```

   El `up -d --build` anterior crea el volumen `storage` (montado en
   `/data/storage`) por primera vez — Docker lo deja con dueño `root:root`,
   pero api/worker corren como `node` (uid 1000, ver Dockerfile). Sin este
   paso, la primera cuenta IMAP que se cree falla con
   `EACCES: permission denied, mkdir '/data/storage/...'`:

   ```bash
   docker compose -f docker-compose.prod.yml exec --user root api chown -R node:node /data/storage
   ```

4. Configurá nginx: copiá `nginx/maildte.conf` a `/etc/nginx/sites-available/`,
   reemplazá `DOMINIO` por el real, symlink a `sites-enabled/`, `nginx -t`, y:

   ```bash
   certbot --nginx -d TUDOMINIO
   systemctl reload nginx
   ```

5. Compilá y publicá el panel web (`web/`), proyecto pnpm independiente del
   backend:

   ```bash
   cd web
   pnpm install
   pnpm build          # genera web/dist/ con base '/panel/'
   sudo mkdir -p /var/www/maildte-panel
   sudo rsync -a --delete dist/ /var/www/maildte-panel/
   cd ..
   ```

   El bloque `location /panel/` de `nginx/maildte.conf` sirve ese directorio
   (recargá nginx si ya lo habías configurado en el paso 4 antes de este
   build). Panel y API quedan bajo el mismo origen (`https://TUDOMINIO`), así
   que `CORS_ORIGIN` no necesita tocarse en producción — esa variable solo
   importa para el dev server de Vite en `localhost:5173`.

6. Sembrá el primer SUPERADMIN. Este script corre **fuera** del contenedor
   (la imagen de producción no incluye `ts-node`/`typescript` — ver el
   comentario en `.dockerignore`): desde tu checkout local del repo, con
   `pnpm install` completo, apuntando al Postgres del VPS. La forma más simple
   es correrlo directo en el VPS si tenés Node+pnpm ahí, o vía un túnel SSH
   (`ssh -L 5433:127.0.0.1:5433 usuario@vps`) desde tu máquina:

   ```bash
   DATABASE_URL=postgresql://maildte:<DB_PASSWORD>@127.0.0.1:5433/maildte \
   APP_DATABASE_URL=postgresql://maildte_app:<contraseña>@127.0.0.1:5433/maildte \
   SUPERADMIN_EMAIL=vos@ltsoft.us \
   SUPERADMIN_PASSWORD='<contraseña fuerte>' \
   pnpm run seed:superadmin
   ```

   (Postgres solo escucha en `127.0.0.1:5433` del VPS — nunca expuesto a
   internet, ver `docker-compose.prod.yml`.)

7. Sembrá el catálogo de servicios de correo (Addendum 09). Mismo mecanismo que
   el punto anterior: fuera del contenedor, con `APP_DATABASE_URL`. Es
   idempotente (upsert por `key`), así que se re-ejecuta sin miedo cada vez que
   se agreguen proveedores nuevos:

   ```bash
   APP_DATABASE_URL=postgresql://maildte_app:<contraseña>@127.0.0.1:5433/maildte \
   pnpm run seed:mail-providers
   ```

   En una instalación que ya tenía cuentas cargadas, agregá `-- --link-existing`
   para vincular las que tengan un `imapHost` idéntico al de un perfil. Sin ese
   flag el script no toca ninguna cuenta: las existentes quedan como "servidor
   personalizado" y siguen sincronizando exactamente igual.

8. Programá el respaldo diario (sección 8) en cron.

---

## 2. Migración de una instalación single-tenant existente

Si el VPS ya venía corriendo una versión previa a multi-tenancy (o si es la
primera vez que se aplica la migración `multi_tenancy` sobre datos reales),
corré **una sola vez**, con las mismas variables que el paso 5 anterior más
`STORAGE_ROOT` apuntando al volumen real:

```bash
DATABASE_URL=... STORAGE_ROOT=/data/storage \
SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... \
MIGRATION_ADMIN_EMAIL=... MIGRATION_ADMIN_PASSWORD=... \
pnpm run migrate:to-multitenant
```

Es idempotente (podés re-correrlo sin miedo) y al final imprime una API key de
migración para que el `maildte-pull` que ya estaba en uso siga funcionando sin
reconfiguración adicional del lado del cliente (más allá de la key nueva).

---

## 2.b Actualización a perfiles de servicio de correo (Addendum 09)

Estos son **todos** los pasos para llevar el Addendum 09 a un VPS que ya está
corriendo. Se ejecutan una sola vez, en este orden.

**Qué trae**: catálogo maestro de servicios de correo administrado por
SUPERADMIN, detección automática del proveedor al dar de alta una cuenta, y una
corrección de RLS que arreglaba un 500 intermitente en el login de SUPERADMIN.

**Ventana de servicio**: no hace falta. Ninguna migración reescribe datos
existentes y las cuentas que ya sincronizan siguen funcionando igual (quedan
como "servidor personalizado" hasta que se las vincule a un perfil).

### 1. Traer el código y reconstruir

```bash
cd /opt/maildte
git pull
docker compose -f docker-compose.prod.yml build
```

### 2. Aplicar las migraciones

Las levanta el contenedor `api` al arrancar (`prisma migrate deploy`), así que
alcanza con el `up`. Son dos:

- `20260901120000_mail_providers` — tablas del catálogo y la columna
  `email_accounts.providerId` (nullable, sin backfill: **no toca ninguna fila
  existente**).
- `20260902000000_fix_superadmin_rls_null_tenant` — recrea 3 policies de RLS de
  `users`. No amplía permisos: le devuelve al SUPERADMIN el acceso a su propia
  fila, que perdía cuando la conexión del pool ya había servido a un tenant.

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api | head -40   # confirmar "migrations have been successfully applied"
```

### 3. Sembrar el catálogo de servicios

Corre **fuera** del contenedor (la imagen de producción no trae `ts-node`),
igual que `seed:superadmin` de la sección 1. Es idempotente: se re-ejecuta cada
vez que se agreguen proveedores nuevos.

```bash
cd /opt/maildte
pnpm install          # dispara el postinstall que regenera el cliente Prisma
pnpm exec prisma generate   # explícito, por si el postinstall no corrió

APP_DATABASE_URL=postgresql://maildte_app:<contraseña>@127.0.0.1:5433/maildte \
pnpm run seed:mail-providers
```

> **Por qué el `prisma generate` del host.** Los scripts de `scripts/` corren
> con el `node_modules` de la máquina, no con el del contenedor. El cliente
> Prisma es **código generado a partir del schema**: si no se regenera después
> de un `git pull` que cambió `schema.prisma`, el script falla al compilar con
> `Property 'mailProvider' does not exist on type 'PrismaClient'`. Los
> contenedores no tienen este problema: el `Dockerfile` genera el cliente
> durante el build.
>
> El proyecto declara un `postinstall` propio que lo resuelve. No alcanza con el
> postinstall de `@prisma/client`: pnpm 10 bloquea los scripts de dependencias
> salvo que estén en una lista de permitidos, y esa lista cambió de lugar entre
> versiones de pnpm — si al instalar ves
> `[WARN] The "pnpm" field in package.json is no longer read by pnpm`, estás en
> esa situación. El `prisma generate` explícito de arriba cubre el caso igual.
>
> Ese mismo WARN implica que **argon2 tampoco se compila** en el host. No afecta
> a este paso, pero sí a `seed:superadmin` (sección 1): si lo necesitás y falla,
> ejecutá `pnpm rebuild argon2`.

Deja 9 perfiles y 26 dominios de detección (Gmail/Workspace, Microsoft 365,
Yahoo, iCloud, Zoho, GoDaddy, Namecheap, Hostinger, Rackspace).

### 4. (Opcional) Vincular las cuentas que ya existen

Sin este paso, las cuentas actuales quedan como "servidor personalizado" y
**siguen sincronizando exactamente igual**. El flag las vincula al perfil cuyo
`imapHost` coincida de forma exacta:

```bash
APP_DATABASE_URL=... pnpm run seed:mail-providers -- --link-existing
```

Conviene: a partir de ahí, corregir un host en el catálogo alcanza para todas.
Ojo con la contrapartida de ADR-09.1 antes de decidirlo.

### 5. Publicar el panel web

```bash
cd web && pnpm install && pnpm build     # deja el bundle en web/dist
```

Copiar `web/dist` a donde lo sirva el reverse proxy bajo `/panel`.

### 6. Verificación post-despliegue

```bash
# 1. Login de SUPERADMIN varias veces seguidas (esto fallaba con el bug de RLS)
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "login=%{http_code}\n" \
    -X POST https://api.tudominio.com/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"<superadmin>","password":"<clave>"}'
done
# Esperado: cinco 200. Un 500 significa que la migración de RLS no se aplicó.

# 2. Catálogo cargado (con un token de cualquier usuario)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.tudominio.com/api/v1/mail-providers | head -c 200

# 3. Detección por MX contra un dominio propio real de un cliente
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.tudominio.com/api/v1/mail-providers/resolve?email=alguien@sudominio.com"
```

En el panel, entrando como SUPERADMIN, tiene que aparecer **Servicios de
correo** en el menú, con los 9 perfiles y el botón de probar servidor.

### 7. Antes de habilitar el perfil de Microsoft 365 para clientes

El perfil trae host y puerto correctos (verificado: `outlook.office365.com:993`
responde `* OK Microsoft Exchange IMAP4 service ready`), **pero eso no prueba
que la autenticación básica funcione**. Microsoft viene retirando usuario y
contraseña en IMAP a favor de OAuth2. Probalo con una cuenta real antes de
ofrecerlo; si no funciona, deshabilitá el perfil (`active: false`) desde el
panel en vez de borrarlo.

### Rollback

Las migraciones son aditivas y no destructivas, así que revertir es volver la
imagen a la versión anterior:

```bash
git checkout <commit-anterior>
docker compose -f docker-compose.prod.yml up -d --build
```

Las tablas del catálogo y la columna `providerId` quedan en la base sin uso: el
código viejo no las mira. **Pero si se corrió `--link-existing`**, las cuentas
vinculadas tienen sus columnas `imapHost/imapPort/imapSecure` intactas (nunca se
borran), así que el código viejo las lee y sigue funcionando. No hay pérdida.

---

## 3. Onboarding de un tenant nuevo

Prerrequisito para dar de alta cualquier cuenta de correo: el tenant y su
primer usuario ADMIN tienen que existir. Los crea el SUPERADMIN:

```bash
# 1. Login del SUPERADMIN
curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"vos@ltsoft.us","password":"..."}' | jq -r '.data.accessToken'
SUPER_TOKEN=<pegar el token de arriba>

# 2. Crear el tenant
curl -s -X POST "$API/admin/tenants" -H "Authorization: Bearer $SUPER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Despacho Contable Rivera","slug":"rivera","maxAccounts":5}'
# -> anotar el "id" de la respuesta

# 3. Crear el primer ADMIN de ese tenant
curl -s -X POST "$API/admin/tenants/<tenantId>/users" -H "Authorization: Bearer $SUPER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@rivera.com","name":"Administrador Rivera","password":"..."}'
```

Desde acá, ese ADMIN hace login normal (`POST /auth/login`) y gestiona su
propio tenant (cuentas de correo, usuarios, API keys) sin volver a necesitar
al SUPERADMIN.

**Suspender / reactivar un tenant** (por ejemplo, falta de pago):

```bash
curl -X POST "$API/admin/tenants/<tenantId>/suspend"  -H "Authorization: Bearer $SUPER_TOKEN"
curl -X POST "$API/admin/tenants/<tenantId>/activate" -H "Authorization: Bearer $SUPER_TOKEN"
```

Suspender remueve los jobs repetibles de sync de ese tenant (sus cuentas dejan
de sincronizar) y bloquea su API de negocio con `403 TENANT_SUSPENDED`;
activar restaura ambas cosas.

**Cuotas**: `maxAccounts` y `maxStorageBytes` se ajustan con
`PATCH /admin/tenants/:id`. Ver uso actual con `GET /admin/tenants/:id/usage`.

**Rotación de API keys** (la hace el ADMIN del propio tenant, no el
SUPERADMIN): `POST /api-keys` genera una nueva (el valor en claro solo se
muestra en esa respuesta), `DELETE /api-keys/:id` revoca la vieja. Rotá
primero la nueva en el cliente (`maildte-pull` u otra integración) y confirmá
que funciona antes de revocar la anterior.

---

## 4. Alta de una cuenta de correo (Gmail / Microsoft 365 / cPanel)

Todas las cuentas se crean con `POST /accounts` autenticado como ADMIN del
tenant (`Authorization: Bearer $TOKEN`, con el token de un login de ADMIN —
ver sección 3). El sistema valida la conexión IMAP **antes** de guardar nada;
si falla, no persiste la cuenta y devuelve el motivo exacto (`IMAP_AUTH_FAILED`,
`IMAP_HOST_UNREACHABLE`, `IMAP_TLS_ERROR`).

### Gmail

1. La cuenta de Gmail tiene que tener **verificación en 2 pasos activada**
   (requisito de Google para generar app passwords).
2. En [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   generar una "contraseña de aplicación" nueva (nombre sugerido: "MailDTE
   Collector"). Google muestra 16 caracteres sin espacios — copiarlos tal
   cual, es la `imapPassword` que va en el POST, **no** la contraseña normal
   de la cuenta.
3. Datos de conexión: `imapHost: imap.gmail.com`, `imapPort: 993`,
   `imapSecure: true`, `imapUser`: el email completo de Gmail.

```bash
curl -X POST "$API/accounts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "alias": "Compras Casa Matriz",
  "email": "compras@ltsoft.us",
  "imapHost": "imap.gmail.com",
  "imapPort": 993,
  "imapSecure": true,
  "imapUser": "compras@ltsoft.us",
  "imapPassword": "abcdabcdabcdabcd"
}'
```

### Microsoft 365

1. Microsoft **deshabilitó por default la autenticación básica IMAP** en
   tenants nuevos (desde 2023). Un admin de M365 tiene que habilitar
   "Authenticated SMTP"/IMAP básico para ese buzón específico, o usar una
   licencia/política que lo permita — sin esto, la conexión falla con
   `IMAP_AUTH_FAILED` aunque la contraseña sea correcta. Verificarlo en el
   Centro de administración de Microsoft 365 antes de reportar un bug acá.
2. Si la cuenta tiene MFA activado (recomendado), generar un app password
   desde [mysignins.microsoft.com/security-info](https://mysignins.microsoft.com/security-info)
   ("Agregar método de inicio de sesión" → "Contraseña de aplicación") — solo
   disponible si el admin de M365 habilitó app passwords para el tenant.
3. Datos de conexión: `imapHost: outlook.office365.com`, `imapPort: 993`,
   `imapSecure: true`, `imapUser`: el email completo.

### cPanel (hosting compartido tradicional)

1. La mayoría de los cPanel no requieren app password: la contraseña normal
   del buzón de correo funciona directo sobre IMAP con TLS.
2. El host IMAP suele ser `mail.tudominio.com` (o el hostname del servidor
   de cPanel — confirmarlo en cPanel → Cuentas de Correo → Configurar Cliente
   de Correo → "Configuración de correo seguro"). Puerto `993`, TLS
   obligatorio (`imapSecure: true`) — este sistema nunca acepta
   `rejectUnauthorized: false`, así que si el certificado del hosting es
   inválido/autofirmado, la conexión va a fallar con `IMAP_TLS_ERROR` y hay
   que resolverlo del lado del hosting (certificado válido), no relajando la
   validación acá.
3. `imapUser` normalmente es el email completo, aunque algunos cPanel piden
   sin el dominio — probar con el email completo primero.

### Verificar y sincronizar manualmente

```bash
curl -X POST "$API/accounts/<id>/test" -H "Authorization: Bearer $TOKEN"   # re-valida la conexión sin tocar nada más
curl -X POST "$API/accounts/<id>/sync" -H "Authorization: Bearer $TOKEN"   # encola un sync inmediato (no espera al scheduler)
```

---

## 5. Procedimiento ante `ERROR_AUTH`

Una cuenta pasa a `status: ERROR_AUTH` automáticamente después de **3 fallos
de autenticación IMAP consecutivos** (`IMAP_AUTH_FAILED`, ver skill
`queues-worker`). En ese estado: el scheduler la excluye (se remueve su job
repetible — no vuelve a intentar sincronizar sola) y `account.lastError` queda
con el detalle del último fallo.

1. Confirmar el estado y el error:

   ```bash
   curl "$API/accounts/<id>" -H "Authorization: Bearer $TOKEN" | jq '.data | {status, lastError}'
   ```

2. Resolver la causa real (contraseña rotada, app password revocado, 2FA
   recién activado invalidando la contraseña vieja, IMAP deshabilitado del
   lado del proveedor, etc. — ver sección 4 para cada proveedor).

3. Actualizar las credenciales con `PATCH /accounts/:id`. Esto **revalida la
   conexión IMAP antes de guardar** (igual que en el alta); si la revalidación
   pasa, la transición es automática: `status` vuelve a `ACTIVA`, se resetea
   el contador de fallos consecutivos, y se vuelve a registrar el job
   repetible — no hace falta ningún paso manual adicional.

   ```bash
   curl -X PATCH "$API/accounts/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"imapPassword": "nuevo-app-password-de-16-chars"}'
   ```

4. Si la revalidación vuelve a fallar, el PATCH se rechaza (nada se
   persiste) y la cuenta sigue en `ERROR_AUTH` — repetir desde el paso 2.

---

## 6. Reprocesar un período (recuperar correos ya sincronizados una vez)

Casos típicos: se subió `maxStorageBytes` después de que varios correos
quedaran `ERROR QUOTA_EXCEEDED`, o se necesita re-descargar un rango de fechas
por cualquier motivo operativo.

**No existe un endpoint de API para esto a propósito** (evita que alguien lo
dispare por accidente): `lastUid` y `syncFromDate` no están en el DTO de
`PATCH /accounts`. Se hace con una consulta directa a la base, conectando como
el rol owner (`maildte`, nunca `maildte_app`):

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -c "
    UPDATE email_accounts
    SET \"lastUid\" = 0, \"syncFromDate\" = '2026-07-01T00:00:00Z'
    WHERE id = '<accountId>';
  "
curl -X POST "$API/accounts/<accountId>/sync" -H "Authorization: Bearer $TOKEN"
```

Esto hace que el próximo sync vuelva a recorrer el buzón desde
`syncFromDate`. **No genera duplicados**: la garantía la da el constraint
`@@unique([accountId, messageId])` — cualquier correo que ya esté en
`processed_emails` se detecta como ya procesado y se saltea (`emailsSkipped`
en el `SyncLog`), y los adjuntos con el mismo sha256 se reutilizan sin
reescribirse (`reused: true`). Solo se descarga lo que genuinamente faltaba
(por ejemplo, los que quedaron `ERROR QUOTA_EXCEEDED` la vez anterior).

---

## 7. Lectura de logs del worker

El worker loguea en JSON estructurado (pino) con `accountId` y `syncId` como
contexto en cada línea de un mismo sync — son la forma de correlacionar todas
las líneas de una sincronización puntual.

```bash
# Seguir en vivo
docker compose -f docker-compose.prod.yml logs -f worker

# Filtrar por cuenta (requiere jq)
docker compose -f docker-compose.prod.yml logs worker | jq -c 'select(.accountId == "<id>")'

# Solo errores
docker compose -f docker-compose.prod.yml logs worker | jq -c 'select(.level >= 50)'
```

Para el resultado consolidado de cada corrida (no línea por línea), `GET
/sync-logs?accountId=<id>&status=ERROR` da los mismos datos que terminan en
`SyncLog` (contadores de `emailsFound/emailsProcessed/emailsSkipped/
filesDownloaded`, `status`, `errorDetail`) sin tener que leer logs crudos.

---

## 8. Respaldo y restauración

### Respaldo (automático, `scripts/backup.sh`)

Programalo en cron en el VPS (como el usuario con permiso de `docker`):

```cron
0 3 * * * STORAGE_ROOT=/data/storage POSTGRES_CONTAINER=maildte-postgres-1 \
  /opt/maildte/scripts/backup.sh >> /var/log/maildte-backup.log 2>&1
```

Verificar el nombre real del contenedor de Postgres con
`docker compose -f docker-compose.prod.yml ps` (puede variar según el nombre
de la carpeta del proyecto). El script deja en `/var/backups/maildte/`:

- `db/maildte_AAAAMMDD_HHMMSS.sql.gz` — un dump por corrida, se borran solo
  los que superan `RETENTION_DAYS` (30 por default).
- `storage/` — espejo incremental de `STORAGE_ROOT` (rsync, sin `--delete`:
  los DTE nunca se borran del origen, así que tampoco se borran del respaldo
  aunque algo desaparezca de golpe del origen).

**Verificar que el respaldo diario corrió bien**: revisar
`/var/log/maildte-backup.log` (debería terminar en "Respaldo completo." sin
errores) y que `db/` tenga un dump con fecha de hoy.

### Restauración

**Base de datos** (a una BD nueva, para no pisar la real por accidente hasta
confirmar que el dump está bien):

```bash
gunzip -c /var/backups/maildte/db/maildte_20260809_030000.sql.gz > /tmp/restore.sql
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U maildte -d postgres -c "CREATE DATABASE maildte_restore;"
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U maildte -d maildte_restore < /tmp/restore.sql
# Verificar los datos en maildte_restore, y recién ahí:
docker compose -f docker-compose.prod.yml stop api worker
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U maildte -d postgres -c "
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'maildte';
    DROP DATABASE maildte;
    ALTER DATABASE maildte_restore RENAME TO maildte;
  "
docker compose -f docker-compose.prod.yml start api worker
```

**Storage** (rsync en sentido inverso, hacia el volumen real):

```bash
docker compose -f docker-compose.prod.yml stop api worker
rsync -a /var/backups/maildte/storage/ /data/storage/
docker compose -f docker-compose.prod.yml start api worker
```

(Detener los servicios acá sí es prudente: estás reemplazando archivos que
podrían estar siendo escritos en ese instante — no es necesario para el
*respaldo*, que es de solo lectura sobre el origen, pero sí para una
*restauración* que sobrescribe.)

---

## 9. Libro de compras: backfill y reprocesamiento de DTE

El libro de compras (Addendum 10) se alimenta solo: cada vez que el sync
archiva un adjunto JSON, encola su lectura en la cola `dte` y el worker lo
incorpora. El reprocesamiento manual hace falta en tres situaciones:

1. **Después de desplegar el Addendum 10 por primera vez** — todos los JSON ya
   archivados son anteriores al parser y nadie los encoló.
2. **Si Redis estuvo caído durante un sync** — el correo se archivó igual (el
   encolado no puede hacer fallar el archivado, a propósito), pero el trabajo
   nunca llegó a la cola.
3. **Al subir `PARSER_VERSION`** — hay documentos leídos con una versión
   anterior de la normalización.

### Diferencia con el §6

El §6 vuelve a **descargar correos** del buzón IMAP. Esto **no toca el buzón ni
`lastUid`**: solo relee archivos que ya están en disco. Por eso sí tiene
endpoint de API y es seguro repetirlo cuantas veces haga falta.

### Disparar el reprocesamiento

Requiere un token de **ADMIN** del tenant (una API key no alcanza: son
`MIEMBRO`). El endpoint responde por páginas con un cursor:

```bash
API=https://<host>/api/v1
TOKEN=<accessToken de un ADMIN del tenant>

# Modo "missing": solo los JSON que nunca se leyeron. Es el caso normal.
curl -s -X POST "$API/purchase-book/reprocess" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"missing"}'
# -> {"data":{"enqueued":500,"nextCursor":"<attachmentId>"}}
```

Mientras `nextCursor` no sea `null` hay más páginas. El bucle completo:

```bash
CURSOR=null
TOTAL=0
while : ; do
  BODY=$([ "$CURSOR" = "null" ] \
    && echo '{"mode":"missing"}' \
    || echo "{\"mode\":\"missing\",\"cursor\":\"$CURSOR\"}")

  RES=$(curl -s -X POST "$API/purchase-book/reprocess" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$BODY")

  TOTAL=$(( TOTAL + $(echo "$RES" | jq '.data.enqueued') ))
  CURSOR=$(echo "$RES" | jq -r '.data.nextCursor')
  echo "encolados hasta ahora: $TOTAL"
  [ "$CURSOR" = "null" ] && break
done
```

El panel web hace exactamente este bucle desde el botón **Reprocesar** de
`/panel/libro-compras`; la vía `curl` es para cuando hay que acotar el alcance
con más precisión o correrlo desatendido.

**Modos disponibles:**

| `mode` | Qué encola |
|---|---|
| `missing` | JSON sin fila en el ledger. El de todos los días. |
| `failed` | Además los estados de error y los leídos con un `parserVersion` anterior. |
| `all` | Todo el filtro, forzando la relectura. **Conserva la clasificación manual Q–T.** |

Filtros opcionales para acotar (`accountId`, `month` sobre la carpeta mensual
del correo, `from`/`to` sobre la fecha de recepción):

```bash
curl -s -X POST "$API/purchase-book/reprocess" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"failed","accountId":"<accountId>","month":"2026-07"}'
```

El endpoint está limitado a 5 llamadas por minuto y cada página encola como
máximo `PURCHASE_BOOK_REPROCESS_BATCH` (1000 por defecto) trabajos.

### Revisar qué pasó con cada archivo

El ledger tiene **una fila por adjunto JSON**, con el resultado de su lectura.
También es ADMIN:

```bash
# Todo lo que no se pudo leer
curl -s "$API/purchase-book/parse-results?status=ERROR" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {originalName: .attachment.originalName, errorDetail}'
```

Estados y qué significan:

| Estado | Significado | ¿Requiere acción? |
|---|---|---|
| `PARSEADO` | Incorporado al libro. | No. |
| `DUPLICADO` | El mismo `codigoGeneracion` ya estaba registrado desde otro adjunto del tenant. Pasa cuando el proveedor manda el DTE a dos buzones de la misma empresa. `documentId` apunta al documento canónico. | **No.** Es el comportamiento correcto, no un error. |
| `IGNORADO_TIPO` | Es un DTE válido pero no es Comprobante de Crédito Fiscal (`tipoDte` distinto de `03`). | No. El libro de compras solo incorpora el `03`. |
| `VERSION_NO_SOPORTADA` | `identificacion.version` fuera de {3, 4}. | Sí: probablemente Hacienda publicó una versión nueva del esquema. |
| `NO_ES_DTE` | JSON válido que no tiene estructura de DTE. Suele ser otro adjunto `.json` cualquiera. | No, salvo que el proveedor deba estar mandando un DTE. |
| `JSON_INVALIDO` | El archivo no es JSON parseable. Emisor con un generador roto. | Sí: pedirle el documento de nuevo al proveedor. |
| `ARCHIVO_FALTANTE` | La fila existe pero el archivo ya no está en el storage. | Sí: revisar respaldos (§8). |
| `ARCHIVO_DEMASIADO_GRANDE` | Excede `DTE_MAX_JSON_BYTES` (2 MiB por defecto). | Revisar el archivo antes de subir el límite. |
| `ERROR` | Faltan campos obligatorios o tienen un tipo inesperado. `errorDetail` lista cada uno con su ruta (`resumen.totalGravada: campo obligatorio ausente`). | Sí: el DTE está mal formado en origen. |

Tras corregir la causa, `mode=failed` vuelve a intentar solo lo que falló.

### Seguir el trabajo en los logs del worker

El worker loguea cada lectura con `tenantId`, `attachmentId`, `status` y
`codigoGeneracion`. **Nunca loguea el contenido del JSON ni nombres o
direcciones del documento.**

```bash
# Todo lo del parseo de DTE
docker compose -f docker-compose.prod.yml logs worker \
  | jq -c 'select(.context == "DteIngestService" or .context == "DteParseProcessor")'

# Un archivo puntual, de punta a punta
docker compose -f docker-compose.prod.yml logs worker \
  | jq -c 'select(.attachmentId == "<attachmentId>")'

# Solo los trabajos que fallaron y se van a reintentar
docker compose -f docker-compose.prod.yml logs worker \
  | jq -c 'select(.context == "DteParseProcessor" and .level >= 50)'
```

Los fallos deterministas (JSON roto, archivo faltante, tipo ignorado) **no se
reintentan**: quedan en el ledger y el trabajo termina bien. Solo se reintentan
los fallos de infraestructura, hasta 3 veces con espera creciente.

### Variables que gobiernan este flujo

| Variable | Default | Para qué |
|---|---|---|
| `DTE_QUEUE_CONCURRENCY` | `4` | Lecturas simultáneas en el worker. Comparte el pool de Prisma con el sync: subirlo mucho compite con la descarga de correo. |
| `DTE_MAX_JSON_BYTES` | `2097152` | Tope de tamaño del JSON antes de leerlo. |
| `PURCHASE_BOOK_REPROCESS_BATCH` | `1000` | Máximo de trabajos por página del reprocesamiento. |
| `PURCHASE_BOOK_EXPORT_MAX_ROWS` | `20000` | Tope de filas del Anexo 3. Por encima, el export responde `422 EXPORT_TOO_LARGE`. |

### El export del Anexo 3 devuelve 422

Tres causas, todas con mensaje explícito en el cuerpo:

- `PURCHASE_BOOK_EMPTY` — el filtro no incluye ninguna compra.
- `EXPORT_TOO_LARGE` — más filas que `PURCHASE_BOOK_EXPORT_MAX_ROWS`. Acotar el
  período.
- `PURCHASE_BOOK_UNCLASSIFIED` — hay compras sin las columnas Q–T resueltas.
  Se arregla configurando los valores por defecto del receptor en
  `/panel/libro-compras/receptores`, o clasificando cada compra desde su
  detalle. Exportar igual con `allowUnclassified=true` genera un archivo con
  esas columnas vacías, que Hacienda puede rechazar.
