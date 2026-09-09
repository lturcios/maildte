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
   REDIS_PASSWORD=<contraseña de Redis>
   REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
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

   `REDIS_PASSWORD` y `REDIS_URL` son **un solo dato en dos lugares** y se
   escriben juntas: el compose arranca Redis con
   `--requirepass ${REDIS_PASSWORD}` y la aplicación se conecta únicamente por
   `REDIS_URL`, que tiene que llevar esa misma clave embebida
   (`redis://:CLAVE@redis:6379`; los dos puntos delante de la clave dejan la
   parte de usuario vacía, porque `--requirepass` fija la contraseña del
   usuario `default` y no hay otro que declarar). Generala con
   `openssl rand -hex 32`, igual que las otras. Si `REDIS_PASSWORD` falta o queda vacía, `docker compose up`
   **aborta** con un mensaje explícito en vez de levantar un Redis sin
   contraseña: es intencional, no un error de configuración del compose.

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

## 2.c Despliegue del libro de compras (Addendum 10)

Estos son **todos** los pasos para llevar el Addendum 10 a un VPS que ya está
corriendo. Se ejecutan una sola vez, en este orden. El paso 6 (backfill inicial)
no es opcional: sin él el libro de compras queda vacío para todos los clientes.

**Qué trae**: lectura automática de los adjuntos JSON de DTE, el libro de
compras consultable por tenant y la exportación del Anexo 3 en CSV y XLSX. Suma
una segunda cola de BullMQ (`dte`) que consume el worker, en paralelo a `sync`.

**Ventana de servicio**: no hace falta. La migración
`20260908035947_purchase_book` es **aditiva**: crea el enum `DteParseStatus`,
seis tablas nuevas (`dte_parties`, `dte_parse_results`, `purchase_documents`,
`purchase_document_items`, `purchase_document_taxes`,
`purchase_document_payments`), sus `GRANT` al rol `maildte_app` y una policy
`tenant_isolation` con `FORCE ROW LEVEL SECURITY` en cada una. No reescribe
ninguna fila existente ni toca ninguna tabla anterior, así que la sincronización
de correo sigue corriendo durante todo el despliegue.

### 1. Traer el código y reconstruir

```bash
cd /opt/maildte
git pull
docker compose -f docker-compose.prod.yml build
```

Este despliegue **agrega un puerto publicado** a `redis` en
`docker-compose.prod.yml` (`127.0.0.1:6380:6379`, solo loopback): el backfill
del paso 6 corre en el host y necesita encolar en la cola `dte`. Si el VPS ya
tiene algo escuchando en 6380, cambiá el puerto del lado izquierdo y usá el
mismo en el `REDIS_URL` del paso 6.

### 1.b Poner contraseña a Redis — un solo paso, las dos variables juntas

Hasta este despliegue, Redis corría **sin autenticación**. Al publicarle un
puerto, aunque sea solo en loopback, cualquier proceso del VPS podía hablarle:
leer y borrar la cola, y leer los locks de sincronización. A partir de acá el
compose lo arranca con `--requirepass` y queda con el mismo criterio que
postgres (contraseña obligatoria, publicado solo en loopback).

> **`REDIS_PASSWORD` y `REDIS_URL` se editan en la misma pasada, antes del
> `up -d` del paso 2.** Son la misma clave en dos lugares: `REDIS_PASSWORD` es
> la que exige el servidor y `REDIS_URL` es la única que lee la aplicación.
> Si cambiás una sin la otra, el `up -d` recrea los contenedores y la
> aplicación no logra hablar con Redis: `GET /health` devuelve 503
> (`"redis":"down"`), así que `api` queda en `unhealthy` y `worker` **no
> arranca**, porque su `depends_on` exige que `api` esté `healthy`. **No hay
> degradación parcial: la sincronización de correo se detiene.**

En el `.env` junto al compose, agregá y ajustá estas dos líneas juntas:

```env
REDIS_PASSWORD=<openssl rand -hex 32>
REDIS_URL=redis://:<esa misma clave>@redis:6379
```

Los dos puntos delante de la clave no son un error de tipeo: `--requirepass`
fija la contraseña del usuario `default` de Redis y no hay otro usuario que
declarar, así que la parte de usuario de la URL va vacía. ioredis interpreta
esa forma como "solo contraseña". También sirve `redis://default:CLAVE@...`;
elegí una y usá la misma en todos lados.

Si `REDIS_PASSWORD` falta o queda vacía, `docker compose up` **aborta** con el
mensaje `REDIS_PASSWORD es obligatoria...` en vez de levantar un Redis sin
contraseña que parezca configurado. Podés comprobarlo antes de tocar nada:

```bash
docker compose -f docker-compose.prod.yml config >/dev/null && echo "compose OK"
```

Después del `up -d` del paso 2, verificá que la autenticación quedó activa —
el primer comando **tiene que fallar** y el segundo **tiene que responder
`PONG`**:

```bash
# 1. Sin credenciales: rechazado (imprime "NOAUTH Authentication required.")
docker compose -f docker-compose.prod.yml exec redis \
  env -u REDISCLI_AUTH redis-cli ping

# 2. Con credenciales (REDISCLI_AUTH ya viene en el entorno del contenedor)
docker compose -f docker-compose.prod.yml exec redis redis-cli ping
# -> PONG

# 3. El contenedor quedó healthy (el healthcheck exige el PONG literal)
docker compose -f docker-compose.prod.yml ps redis
# -> STATUS: Up ... (healthy)
```

**Ojo con el primer comando**: `redis-cli ping` imprime el error `NOAUTH` pero
termina con código de salida **0**. Por eso el healthcheck del compose no se
conforma con el código de salida y exige el `PONG` literal
(`redis-cli ping | grep -q PONG`); si te guiás por `echo $?` para juzgar si la
autenticación está activa, te va a mentir. Mirá la salida impresa.

El resto de los `docker compose ... exec redis redis-cli ...` de este runbook
(pasos 3 y 7, sección 9) sigue funcionando sin cambios: el compose le pasa
`REDISCLI_AUTH` al contenedor y `redis-cli` la toma sola. Lo que sí cambia es
todo `redis-cli` o `REDIS_URL` que corra **desde el host** — ver el paso 6.

Si después del `up -d` `api` queda `unhealthy` y `worker` no arranca, el
sospechoso número uno es un `REDIS_URL` sin la clave o con una clave distinta a
`REDIS_PASSWORD`:

```bash
curl -s http://127.0.0.1:3000/api/v1/health   # -> {"data":{"status":"error",...,"redis":"down"}}
docker compose -f docker-compose.prod.yml logs api | grep -i "NOAUTH\|WRONGPASS"
```

### 2. Aplicar la migración

La levanta el contenedor `api` al arrancar (`prisma migrate deploy`), igual que
en 2.b, así que alcanza con el `up`:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api | head -40   # confirmar "migrations have been successfully applied"
```

Comprobación directa de que las seis tablas quedaron con RLS forzado (`psql`
entra con el rol **owner** `maildte`, que es superusuario y por lo tanto **no
está sujeto a RLS** — por eso ve todo; el rol de la aplicación, `maildte_app`,
sí lo está):

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -c "
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('dte_parties','dte_parse_results','purchase_documents',
                      'purchase_document_items','purchase_document_taxes',
                      'purchase_document_payments')
    ORDER BY relname;
  "
```

Las seis filas tienen que salir con `t` en las dos columnas.

### 3. Confirmar que el worker consume la cola `dte`

`WorkerModule` ahora importa `PurchaseBookIngestModule`, y `DteParseProcessor`
registra el `Worker` de BullMQ en su `onModuleInit`.

> **No busques una línea de arranque del processor: no existe.**
> `DteParseProcessor` solo loguea cuando un job **falla**. Un worker sano no
> escribe nada suyo al arrancar, así que "no aparece nada en los logs" no es
> señal de problema.

Lo que sí se puede verificar:

```bash
# 1. El módulo se cargó (línea de Nest, contexto InstanceLoader)
docker compose -f docker-compose.prod.yml logs worker \
  | jq -c 'select(.context == "InstanceLoader" and (.msg | test("PurchaseBookIngest")))'
# -> {"context":"InstanceLoader","msg":"PurchaseBookIngestModule dependencies initialized"}

# 2. Hay un consumidor conectado a la cola: BullMQ nombra la conexión del Worker
#    "bull:" + el nombre de la cola en base64 ("dte" -> ZHRl)
docker compose -f docker-compose.prod.yml exec redis \
  redis-cli client list | grep "name=bull:ZHRl"
```

La verificación que de verdad importa es funcional y llega en el paso 6: si la
cola se vacía y `dte_parse_results` crece, el worker está consumiendo.

### 4. (Opcional) Ajustar las variables del libro de compras

Las cuatro tienen valor por defecto en `src/config/env.validation.ts` y el
despliegue funciona sin declarar ninguna. Van en el `.env` junto al compose.

| Variable | Default | Cuándo moverla |
|---|---|---|
| `PURCHASE_BOOK_EXPORT_MAX_ROWS` | `20000` | Subirla solo si un cliente presenta anexos de más de 20.000 líneas por período. El XLSX se arma en memoria: el tope protege al proceso de la API, no al cliente. |
| `PURCHASE_BOOK_REPROCESS_BATCH` | `1000` (máx. `5000`) | Tamaño de página del reprocesamiento y del backfill. Subirla acelera el encolado del paso 6 en instalaciones grandes; bajarla hace más chico cada golpe a la base. |
| `DTE_MAX_JSON_BYTES` | `2097152` (2 MiB) | Subirla solo si aparecen adjuntos legítimos marcados `ARCHIVO_DEMASIADO_GRANDE`. Revisá el archivo primero: un DTE normal pesa kilobytes. |
| `DTE_QUEUE_CONCURRENCY` | `4` (máx. `16`) | Lecturas simultáneas del worker. Subirla acorta el backfill, pero comparte el pool de Prisma con el sync: pasada de rosca, compite con la descarga de correo. |

Cambiar cualquiera de ellas requiere `docker compose -f docker-compose.prod.yml up -d`
para recrear los contenedores con el `.env` nuevo.

### 5. Publicar el panel web

```bash
cd web && pnpm install && pnpm build     # deja el bundle en web/dist
```

Copiar `web/dist` a donde lo sirva el reverse proxy bajo `/panel`, igual que en
2.b. El menú suma **Libro de compras**, con dos rutas nuevas:
`/panel/libro-compras` (listado, detalle, clasificación Q–T y exportación) y
`/panel/libro-compras/receptores` (valores por defecto del Anexo 3 por
contribuyente).

### 6. Backfill inicial — el paso que hace o rompe este despliegue

El libro de compras se alimenta solo: cada JSON que archiva el sync se encola en
la cola `dte`. **Pero todos los JSON archivados antes de este despliegue son
anteriores al parser y nadie los encoló nunca.** Si este paso se saltea, el
panel de libro de compras aparece vacío para todos los tenants y el problema no
se manifiesta como un error: simplemente no hay datos.

**Por qué un script y no el bucle HTTP del §9.** `POST /purchase-book/reprocess`
es por tenant y exige un token **ADMIN de ese tenant**:
`PurchaseBookService.reprocess` llama a `requireTenantId()`, que le responde
`FORBIDDEN_ROLE` al SUPERADMIN, y no existe suplantación de tenant en ningún
punto del sistema. Para un despliegue habría que pedirle una credencial a cada
cliente. El script recorre todos los tenants con el rol de aplicación. El §9
sigue siendo la vía correcta para reprocesar **un** tenant en operación normal.

Corre **fuera** del contenedor (la imagen de producción no trae `ts-node`),
igual que las semillas de la sección 1 y de 2.b. Necesita alcanzar Postgres
**y** Redis desde el host:

```bash
cd /opt/maildte
pnpm install                 # dispara el postinstall que regenera el cliente Prisma
pnpm exec prisma generate    # explícito, por si el postinstall no corrió

# 1. Ensayo: cuenta qué se encolaría, sin tocar Redis
APP_DATABASE_URL=postgresql://maildte_app:<contraseña>@127.0.0.1:5433/maildte \
REDIS_URL=redis://:<REDIS_PASSWORD>@127.0.0.1:6380 \
pnpm run backfill:purchase-book -- --mode=missing --dry-run

# 2. La corrida de verdad
APP_DATABASE_URL=postgresql://maildte_app:<contraseña>@127.0.0.1:5433/maildte \
REDIS_URL=redis://:<REDIS_PASSWORD>@127.0.0.1:6380 \
pnpm run backfill:purchase-book -- --mode=missing
```

El `REDIS_URL` del host **no es el mismo** que el del `.env`: lleva la misma
clave (`REDIS_PASSWORD`, paso 1.b) pero apunta al puerto publicado
(`127.0.0.1:6380`) en vez de al nombre de servicio interno `redis:6379`. Si la
clave se generó con `openssl rand -hex 32` es hexadecimal y entra tal cual en
la URL; una clave con `@`, `/`, `:` o `#` habría que percent-encodearla, así
que conviene no usarlas.

Con la clave mal puesta, el script **no encola nada y lo dice**: `addBulk`
recibe `NOAUTH Authentication required`, `enqueueParseBulk` lo registra en
nivel `error` y devuelve 0, y el backfill corta ese tenant. Cada fila del
reporte sale con `0 ... (parcial); ERROR: Redis aceptó 0 de N trabajos del
lote` y la corrida termina con código de salida distinto de cero. Corregir el
`REDIS_URL` y repetir es seguro (el `jobId` es determinístico).

**El `--dry-run` no sirve para validar la contraseña**: nunca llama a
`enqueue`, así que una clave equivocada le pasa desapercibida y reporta los
conteos como si todo estuviera bien. Si querés probar la conexión antes de la
corrida larga, hacelo con `redis-cli` contra el puerto publicado:

```bash
redis-cli -u "redis://default:<REDIS_PASSWORD>@127.0.0.1:6380" ping
# -> PONG
```

> **Detalle de `redis-cli`, no de la aplicación.** En la URL de `redis-cli` hay
> que poner `default:` como usuario. Con la forma de usuario vacío
> (`redis://:CLAVE@...`) `redis-cli` manda un `AUTH` con usuario `""` y el
> servidor responde `WRONGPASS`, que parece una clave equivocada y no lo es.
> El `REDIS_URL` de la aplicación **sí** funciona con la forma de usuario
> vacío: ioredis la interpreta como "solo contraseña". Las dos formas son
> válidas para `REDIS_URL`; la única que sirve para `redis-cli -u` es
> `default:`.

Salida, una línea por tenant y un total:

```
Backfill del libro de compras — modo missing, lote 1.000

  tenant acme-sa           12.480 encolados
  tenant distribuidora      3.902 encolados
  tenant suspendida-sa           0 omitido (tenant no ACTIVO)
  ------------------------------------------
  2 tenants, 16.382 jobs encolados
```

Notas de uso:

- `--mode` es **obligatorio** y no tiene valor por defecto. Para el despliegue
  inicial es `missing` (solo lo que nunca pasó por el parser). `failed` y `all`
  son los mismos modos del §9.
- `--dry-run` cuenta sin encolar. Igual necesita las dos conexiones: lo que
  evita es el encolado, no la conexión.
- `--tenant=<slug o id>` acota a un solo tenant; `--batch=<n>` cambia el tamaño
  de página (por defecto, `PURCHASE_BOOK_REPROCESS_BATCH`).
- Los tenants que no están `ACTIVO` se enumeran pero no se encolan: el worker
  los descartaría igual al consumir.
- **Es seguro repetirlo.** El `jobId` es determinístico por adjunto, así que dos
  corridas seguidas no duplican trabajo, y el script solo lee la base y encola:
  no escribe ninguna tabla del libro de compras, no toca IMAP ni `lastUid`, y no
  borra nada.
- Si un tenant falla, el script sigue con los demás, lo marca en su fila y
  termina con código de salida distinto de cero. El conteo de esa fila es el
  **parcial** (lo que alcanzó a encolar antes de cortarse) y la fila lo dice:
  `... encolados (parcial); ERROR: ...`. Repetir la corrida es seguro y retoma
  lo que faltó.
- **Corrélo dentro de `tmux` (o con `nohup`).** Sobre decenas de miles de
  adjuntos la corrida dura minutos u horas y una caída del SSH mata el proceso:
  `tmux new -s backfill` antes de empezar, `tmux attach -t backfill` para
  volver. Cada tenant imprime su fila apenas termina, así que lo que ya salió en
  pantalla es trabajo hecho aunque la corrida se corte después.

### 7. Verificación post-despliegue

```bash
# 1. Cuánto falta por consumir en la cola
docker compose -f docker-compose.prod.yml exec redis redis-cli llen bull:dte:wait

# 2. Conciliación por tenant: JSON archivados contra filas del ledger.
#    psql entra como el rol owner (maildte), que es superusuario y NO está
#    sujeto al RLS que sí limita a maildte_app: por eso ve todos los tenants.
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -c "
    SELECT t.slug,
           count(*)               AS json_archivados,
           count(r.id)            AS con_ledger,
           count(*) - count(r.id) AS sin_leer
    FROM tenants t
    JOIN attachments a ON a.\"tenantId\" = t.id AND a.\"fileType\" = 'JSON'
    LEFT JOIN dte_parse_results r ON r.\"attachmentId\" = a.id
    GROUP BY t.slug
    ORDER BY t.slug;
  "

# 3. Desglose de estados por tenant
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -c "
    SELECT t.slug, r.status, count(*)
    FROM dte_parse_results r
    JOIN tenants t ON t.id = r.\"tenantId\"
    GROUP BY t.slug, r.status
    ORDER BY t.slug, r.status;
  "
```

**Cómo se leen juntas esas dos consultas.** Hay exactamente tres desenlaces y no
conviene deducirlos: esta funcionalidad ya falló una vez en modo "todo se ve
bien y no hace nada", así que la conclusión va escrita.

| `llen bull:dte:wait` | `sin_leer` (tenants activos) | Estado | Qué hacer |
|---|---|---|---|
| `0` | `0` | **Terminado.** El backfill se consumió entero. | Nada. Seguir con el desglose de estados de abajo. |
| `> 0` y **bajando** entre dos lecturas separadas por 60 s | `> 0` y bajando | **Todavía drenando.** El worker consume, falta tiempo. | Esperar. Medir el ritmo con las dos lecturas de `dte_parse_results` de "Cuánto tarda" y, si hace falta, subir `DTE_QUEUE_CONCURRENCY` (paso 4). |
| `> 0` y **estancado** en dos lecturas separadas por 60 s | `> 0` sin moverse | **El worker no está consumiendo.** | Revisar el paso 3: `client list \| grep name=bull:ZHRl` (sin consumidor conectado, `PurchaseBookIngestModule` no arrancó) y los logs del worker (§9, "Seguir el trabajo en los logs"). Reiniciar el worker si el módulo no cargó. |

Un cuarto caso que no es ninguno de los tres: **`llen` en 0 y `sin_leer` > 0**
apenas terminado el script. Ahí la cola nunca recibió los trabajos. Buscar
`"el lote se perdió"` en los logs (la API y el worker lo registran en nivel
`error`) y volver a correr el backfill; si el script terminó con código 0 y sin
filas `(parcial)`, el problema está del lado del consumo, no del encolado.

Los estados que sí piden acción se miran por API, con un token ADMIN del tenant
(la tabla de significados de cada estado está en el §9):

```bash
curl -s "$API/purchase-book/parse-results?status=ERROR" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {originalName: .attachment.originalName, errorDetail}'
```

`DUPLICADO` e `IGNORADO_TIPO` son resultados normales, no fallas: el primero es
el mismo DTE llegado a dos buzones de la misma empresa y el segundo, un DTE que
no es Comprobante de Crédito Fiscal.

### Cuánto tarda

El encolado (el script) es rápido: recorre la base por páginas y manda cada
lote a Redis de una sola llamada. El cuello de botella es el **consumo**: el
worker procesa `DTE_QUEUE_CONCURRENCY` archivos en paralelo (4 por defecto) y
cada job lee un JSON del disco, lo normaliza y escribe el documento con sus
ítems, tributos y pagos en una transacción.

**No hay una medición de costo por job en producción**, así que lo que sigue es
un orden de magnitud, no un número: con 4 en paralelo, 100.000 adjuntos van de
unas decenas de minutos a unas pocas horas según lo que tarde cada lectura. Lo
importante es que **no parece colgado**: se mide.

```bash
# Velocidad real: la diferencia entre las dos lecturas es lo procesado en 60 s
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -t -c "SELECT count(*) FROM dte_parse_results;"
sleep 60
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U maildte -d maildte -t -c "SELECT count(*) FROM dte_parse_results;"
```

Si hace falta acelerar, subir `DTE_QUEUE_CONCURRENCY` (paso 4) y recrear el
worker. Recordá que comparte el pool de Prisma con la sincronización de correo:
conviene hacerlo en una ventana de poco movimiento y volver al valor anterior
al terminar el backfill.

### Rollback

La migración es aditiva y no destructiva, así que revertir es volver la imagen a
la versión anterior:

```bash
git checkout <commit-anterior>
docker compose -f docker-compose.prod.yml up -d --build
```

Las seis tablas y el enum quedan en la base sin uso: el código viejo no los
mira, y como ninguna tabla anterior cambió, la sincronización de correo sigue
igual. Los documentos ya leídos **no se borran**: quedan en `purchase_documents`
y en el ledger, y si más adelante se vuelve a desplegar el Addendum 10 siguen
ahí — el backfill en `mode=missing` no los vuelve a encolar, porque ya tienen
fila en `dte_parse_results`. Lo único que se pierde al revertir es el acceso:
las rutas de la API y del panel dejan de existir.

Si además se quiere devolver el `docker-compose.prod.yml` a su estado anterior,
quitar el puerto publicado de `redis` no afecta a nada en runtime: solo lo usan
los scripts de mantenimiento del host.

**Quitar la contraseña de Redis es la operación inversa del paso 1.b y también
se hace de una sola vez.** El `git checkout <commit-anterior>` devuelve el
compose a un Redis sin `--requirepass`, así que en la misma pasada hay que
volver `REDIS_URL` a `redis://redis:6379` en el `.env`. El orden importa
distinto en cada sentido, y conviene tenerlo claro antes de tocar:

- **Sacar la clave del `REDIS_URL` sin sacarla del servidor es fatal**: Redis
  la sigue exigiendo, `api` y `worker` se quedan en `NOAUTH` y la
  sincronización se detiene.
- **El caso contrario es benigno**: si el servidor deja de pedirla y el
  `REDIS_URL` todavía la lleva, ioredis conecta igual y solo deja un `[WARN]`
  (`This Redis server's default user does not require a password, but a
  password was supplied`). Es incómodo, no una caída.

Por eso, si el rollback se hace por partes, sacala primero del **servidor** y
después del `REDIS_URL`. Dejar la contraseña puesta también es una opción
válida: no depende del Addendum 10 y no cuesta nada mantenerla.

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
   archivados son anteriores al parser y nadie los encoló. **Ese caso no se
   resuelve con esta sección**: es multi-tenant y el endpoint de acá exige un
   token ADMIN de cada tenant (`requireTenantId()` le responde `FORBIDDEN_ROLE`
   al SUPERADMIN). Va con el script `backfill:purchase-book` del **§2.c, paso
   6**, que recorre todos los tenants desde el host. Lo de abajo es la vía para
   reprocesar **un** tenant.
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

**Si responde `503 PURCHASE_BOOK_QUEUE_UNAVAILABLE`**: la página tenía adjuntos
para encolar y la cola `dte` no aceptó el lote (Redis caído, sin memoria o
rechazando la escritura). No se encoló nada de esa página y el cursor no avanzó,
así que **el bucle de arriba se corta ahí y hay que reintentarlo entero**: es
seguro, el `jobId` es determinístico por adjunto. Antes de reintentar, mirar por
qué no acepta la cola:

```bash
docker compose -f docker-compose.prod.yml exec redis redis-cli ping    # -> PONG
docker compose -f docker-compose.prod.yml logs api | jq -c 'select(.msg | test("el lote se perdió"))'
```

Un `{"enqueued":0,"nextCursor":null}` es otra cosa y no es un error: significa
que el filtro no encontró nada que encolar. La distinción es el motivo de que
este 503 exista.

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

Cinco causas, todas con mensaje explícito en el cuerpo:

- `PURCHASE_BOOK_EMPTY` — el filtro no incluye ninguna compra.
- `EXPORT_TOO_LARGE` — más filas que `PURCHASE_BOOK_EXPORT_MAX_ROWS`. Acotar el
  período.
- `PURCHASE_BOOK_UNCLASSIFIED` — hay compras sin las columnas Q–T resueltas.
  Se arregla configurando los valores por defecto del receptor en
  `/panel/libro-compras/receptores`, o clasificando cada compra desde su
  detalle. Exportar igual con `allowUnclassified=true` genera un archivo con
  esas columnas vacías, que Hacienda puede rechazar.
- `PURCHASE_BOOK_MULTIPLE_RECEPTORS` — el conjunto a exportar tiene compras de
  más de un receptor. El Anexo 3 se presenta por contribuyente: un archivo
  mezclado declararía compras de otra empresa. Se arregla exportando un receptor
  por vez. El parámetro `receptorId` es obligatorio en `/purchase-book/export`,
  así que este error indica una regresión del armado del filtro, no un uso
  incorrecto: si aparece, hay que revisar `buildPurchaseDocumentWhere` antes de
  volver a exportar.

- `PURCHASE_BOOK_RECEPTOR_REQUIRED` — el export llegó al servicio sin
  `receptorId`. El Anexo 3 se presenta por contribuyente: sin receptor el
  archivo no es presentable. Igual que el error anterior, indica una regresión y
  no un uso incorrecto: el DTO ya devuelve `400` antes de llegar acá, así que si
  aparece hay que revisar la validación de `ExportPurchaseBookDto` (un
  `@IsOptional()` heredado ya la dejó inerte una vez) antes de volver a exportar.

Además, un export sin `receptorId` responde `400` desde el `ValidationPipe`
(`"receptorId debe ser un UUID válido"`). No es un error de datos: el anexo no
existe sin un contribuyente que lo presente.
