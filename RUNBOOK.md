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
   ```

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

7. Programá el respaldo diario (sección 8) en cron.

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
