# Arquitectura Técnica — MailDTE Collector
**v1.0 — Base de diseño para implementación con Claude Code**

---

## 1. Stack tecnológico (fijo, no negociable)

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework backend | NestJS 10 + TypeScript strict |
| ORM / BD | Prisma + PostgreSQL 16 |
| Colas y scheduler | BullMQ + Redis 7 |
| Cliente IMAP | `imapflow` |
| Parseo MIME | `mailparser` |
| Logs | `pino` (JSON estructurado) |
| Validación | `class-validator` + `class-transformer` (DTOs NestJS) |
| Gestor de paquetes | pnpm (exclusivamente) |
| Despliegue | Docker Compose + Nginx en VPS |
| Panel web (fase 2) | React 19 + Vite + Tailwind + shadcn/ui + Zustand |

## 2. Diagrama de componentes

```
                    ┌─────────────────────────────────────────┐
                    │              VPS (Docker)               │
                    │                                         │
 Proveedores IMAP   │  ┌──────────┐      ┌────────────────┐   │
 (Gmail, M365,   ◄──┼──┤  Worker  │◄─────┤   Scheduler    │   │
  cPanel...)        │  │  BullMQ  │      │ (jobs repeat.) │   │
                    │  └────┬─────┘      └───────┬────────┘   │
                    │       │                    │            │
                    │       ▼                    ▼            │
                    │  ┌──────────┐        ┌─────────┐        │
                    │  │ Storage  │        │  Redis  │        │
                    │  │ (volumen)│        └─────────┘        │
                    │  └──────────┘                           │
                    │       ▲                                 │
                    │       │            ┌──────────────┐     │
  Cliente API /  ◄──┼── Nginx ──────────►│  API NestJS  │     │
  Panel (fase 2)    │                    └──────┬───────┘     │
                    │                           ▼             │
                    │                    ┌──────────────┐     │
                    │                    │ PostgreSQL16 │     │
                    │                    └──────────────┘     │
                    └─────────────────────────────────────────┘
```

API y Worker corren en el **mismo repositorio** (monorepo simple NestJS) pero como **procesos separados** (`main.ts` para API, `worker.ts` para consumidor BullMQ), permitiendo escalar workers independientemente.

## 3. Estructura del proyecto

```
maildte/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── main.ts                      # bootstrap API HTTP
│   ├── worker.ts                    # bootstrap proceso worker BullMQ
│   ├── app.module.ts
│   ├── config/
│   │   ├── config.module.ts         # @nestjs/config + validación Joi de env
│   │   └── env.validation.ts
│   ├── common/
│   │   ├── guards/api-key.guard.ts
│   │   ├── filters/http-exception.filter.ts
│   │   ├── crypto/aes.service.ts    # AES-256-GCM encrypt/decrypt
│   │   └── utils/sanitize-filename.ts
│   ├── prisma/
│   │   └── prisma.service.ts
│   ├── accounts/                    # F-01 gestión de cuentas
│   │   ├── accounts.module.ts
│   │   ├── accounts.controller.ts
│   │   ├── accounts.service.ts
│   │   └── dto/
│   ├── sync/                        # F-02 orquestación
│   │   ├── sync.module.ts
│   │   ├── sync.scheduler.ts        # registra jobs repetibles por cuenta
│   │   ├── sync.processor.ts        # consumidor BullMQ (proceso worker)
│   │   ├── sync.service.ts          # lógica de sincronización
│   │   └── imap/
│   │       ├── imap-client.factory.ts
│   │       └── message-parser.ts    # mailparser → EmailMeta + adjuntos
│   ├── storage/                     # F-04 filesystem
│   │   ├── storage.module.ts
│   │   └── storage.service.ts       # rutas cuenta/mes, tmp+rename, hash
│   ├── emails/                      # F-05 consulta y auditoría
│   │   ├── emails.module.ts
│   │   ├── emails.controller.ts
│   │   ├── emails.service.ts
│   │   └── dto/
│   └── stats/
│       ├── stats.module.ts
│       └── stats.controller.ts
├── test/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── CLAUDE.md
└── package.json
```

## 4. Esquema de base de datos (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum AccountStatus {
  ACTIVA
  INACTIVA
  ERROR_AUTH
}

enum EmailStatus {
  PROCESADO
  SIN_ADJUNTOS
  ERROR
}

enum AttachmentType {
  JSON
  PDF
}

enum SyncStatus {
  EJECUTANDO
  COMPLETADO
  COMPLETADO_CON_ERRORES
  ERROR
}

model EmailAccount {
  id            String        @id @default(uuid())
  alias         String                          // "Compras Casa Matriz"
  email         String        @unique           // compras@ltsoft.us
  folderName    String                          // compras_ltsoft_us (normalizado)
  imapHost      String
  imapPort      Int           @default(993)
  imapSecure    Boolean       @default(true)
  imapUser      String
  imapPassEnc   String                          // AES-256-GCM (iv:tag:cipher, base64)
  mailbox       String        @default("INBOX")
  syncInterval  Int           @default(300)     // segundos
  syncFromDate  DateTime      @default(now())
  lastUid       Int           @default(0)
  uidValidity   BigInt?                         // detección de reset del buzón
  lastSyncAt    DateTime?
  lastError     String?
  status        AccountStatus @default(ACTIVA)
  deletedAt     DateTime?                       // soft delete
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  emails        ProcessedEmail[]
  syncLogs      SyncLog[]

  @@map("email_accounts")
}

model ProcessedEmail {
  id              String       @id @default(uuid())
  accountId       String
  account         EmailAccount @relation(fields: [accountId], references: [id])
  messageId       String                        // header Message-ID
  uid             Int                           // UID IMAP
  subject         String       @default("")
  senderName      String       @default("")
  senderEmail     String
  recipients      String[]                      // direcciones To
  receivedAt      DateTime                      // header Date (UTC)
  processedAt     DateTime     @default(now())
  monthFolder     String                        // "2026-08" (TZ El Salvador)
  attachmentCount Int          @default(0)
  status          EmailStatus
  errorDetail     String?

  attachments     Attachment[]

  @@unique([accountId, messageId])              // idempotencia
  @@index([accountId, receivedAt])
  @@index([senderEmail])
  @@index([status])
  @@map("processed_emails")
}

model Attachment {
  id            String         @id @default(uuid())
  emailId       String
  email         ProcessedEmail @relation(fields: [emailId], references: [id])
  originalName  String
  storedName    String
  relativePath  String                          // compras_ltsoft_us/2026-08/json/x.json
  fileType      AttachmentType
  mimeType      String
  sizeBytes     Int
  sha256        String
  createdAt     DateTime       @default(now())

  @@index([emailId])
  @@index([sha256])
  @@map("attachments")
}

model SyncLog {
  id              String       @id @default(uuid())
  accountId       String
  account         EmailAccount @relation(fields: [accountId], references: [id])
  startedAt       DateTime     @default(now())
  finishedAt      DateTime?
  emailsFound     Int          @default(0)
  emailsProcessed Int          @default(0)
  emailsSkipped   Int          @default(0)     // duplicados
  filesDownloaded Int          @default(0)
  status          SyncStatus   @default(EJECUTANDO)
  errorDetail     String?
  trigger         String       @default("scheduler") // scheduler | manual

  @@index([accountId, startedAt])
  @@map("sync_logs")
}
```

### Notas de diseño de BD
- `@@unique([accountId, messageId])` es la garantía dura de idempotencia; cualquier intento de doble inserción falla a nivel de constraint.
- `uidValidity`: si el servidor IMAP cambia el `UIDVALIDITY` del buzón, los UID anteriores dejan de ser válidos → el sistema resetea `lastUid = 0` y confía en la idempotencia por `messageId` para no duplicar.
- `monthFolder` se persiste (no se recalcula) para que la BD y el disco nunca diverjan aunque cambie la lógica de TZ.
- Fechas siempre en UTC en BD; conversión a `America/El_Salvador` solo al calcular `monthFolder` y al presentar en API.
- **`mail_providers` y `mail_provider_domains` (Addendum 09) NO llevan RLS, y es deliberado.** Son un catálogo global sin `tenantId`: no hay columna contra la cual escribir una policy de aislamiento. En Postgres una tabla sin RLS queda accesible para cualquier rol con GRANT, que es justo lo necesario para poder leer el catálogo dentro de las transacciones de `withTenant()`. La escritura se restringe en la capa de aplicación con `@Roles(SUPERADMIN)`.
- **Contar filas de una tabla con RLS a través de todos los tenants exige recorrerlos.** `email_accounts` tiene RLS FORCE con una policy de igualdad contra `app.tenant_id`: una consulta sin tenant en contexto devuelve **cero filas, no un error**. `MailProvidersService.usageAll()` recorre las organizaciones y agrupa dentro de `withTenant()` en cada una. Es N+1 a propósito sobre endpoints de SUPERADMIN; debilitar la policy para ahorrárselo abriría una fuga entre tenants.
- **`current_setting('app.tenant_id', true)` no vuelve a NULL al terminar la transacción: queda en string vacío.** Una policy que identifique "sin tenant en contexto" con `IS NULL` deja de funcionar en cuanto esa conexión del pool sirvió un request con tenant. Toda comparación con esa GUC va envuelta en `nullif(..., '')` — ver la migración `fix_superadmin_rls_null_tenant`, que corrigió por esto un 500 intermitente en el login de SUPERADMIN.

## 5. Flujo detallado de sincronización

```
1. Scheduler (proceso API) registra job repetible "sync:{accountId}"
   con every = syncInterval por cada cuenta ACTIVA.
2. Worker recibe el job:
   a. SET NX lock redis "lock:sync:{accountId}" TTL 10 min → si existe, abortar.
   b. Crear SyncLog (EJECUTANDO).
   c. ImapFlow.connect() con credenciales descifradas.
   d. mailboxOpen(mailbox) → comparar uidValidity; si cambió: lastUid = 0.
   e. fetch("{lastUid+1}:*", { uid: true, envelope: true, source: true })
   f. Por cada mensaje (secuencial, para orden y control de memoria):
      i.   Parsear con mailparser (desde source).
      ii.  ¿Existe (accountId, messageId)? → skip, emailsSkipped++.
      iii. Filtrar adjuntos: /\.(json|pdf)$/i sobre filename
           OR mimeType ∈ {application/json, application/pdf}.
      iv.  Sin adjuntos válidos → insertar ProcessedEmail(SIN_ADJUNTOS).
      v.   Con adjuntos:
           - Calcular monthFolder con receivedAt en TZ America/El_Salvador.
           - Por adjunto: sanitizar nombre → sha256 → resolver colisión
             → escribir a .tmp → fsync → rename.
           - Transacción Prisma: ProcessedEmail + Attachments.
           - Si falla la transacción → borrar archivos escritos de este
             correo (rollback en disco) → registrar ERROR.
      vi.  Actualizar account.lastUid = max(lastUid, uid) tras cada correo
           exitoso (no al final del lote: una caída no repite trabajo).
   g. Cerrar conexión, SyncLog → COMPLETADO / COMPLETADO_CON_ERRORES.
   h. DEL lock.
3. Fallo de conexión/global → reintentos BullMQ: attempts 3,
   backoff exponencial base 30s. Agotados → SyncLog ERROR,
   account.lastError. Si el error es de autenticación 3 veces
   consecutivas → account.status = ERROR_AUTH (se excluye del scheduler
   hasta actualizar credenciales).
```

## 6. Reglas de almacenamiento

```
STORAGE_ROOT (env, default /data/storage)
└── {folderName}/                    ej. compras_ltsoft_us/
    └── {YYYY-MM}/                   ej. 2026-08/
        ├── json/
        └── pdf/
```

1. **Normalización de cuenta**: lowercase, `@` y `.` → `_`, solo `[a-z0-9_-]`.
2. **Sanitización de nombre**: remover `/ \ : * ? " < > |` y caracteres de control; colapsar espacios; máx. 180 chars conservando extensión.
3. **Colisiones**: mismo nombre + mismo sha256 → reutilizar archivo (registrar Attachment apuntando a ruta existente). Mismo nombre + distinto sha256 → `factura_a1b2c3d4.pdf`.
4. **Escritura atómica**: `archivo.pdf.tmp` → `fsync` → `rename`. Al iniciar cada sync se eliminan `*.tmp` huérfanos de la cuenta.
5. **Permisos**: el volumen se monta con usuario no-root del contenedor (uid 1000).

## 7. API REST (prefijo `/api/v1`, auth `X-Api-Key`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/accounts` | Crear cuenta (valida IMAP antes de persistir) |
| GET | `/accounts` | Listar cuentas (sin credenciales) |
| GET | `/accounts/:id` | Detalle + últimas sincronizaciones |
| PATCH | `/accounts/:id` | Actualizar (si cambia credencial → revalidar IMAP) |
| DELETE | `/accounts/:id` | Soft delete |
| POST | `/accounts/:id/sync` | Sincronización manual inmediata |
| POST | `/accounts/:id/test` | Probar conexión IMAP |
| GET | `/emails` | Listado con filtros: `accountId, from, to, sender, status, hasAttachments, page, limit` |
| GET | `/emails/:id` | Detalle con adjuntos |
| GET | `/attachments/:id/download` | Stream del archivo |
| GET | `/sync-logs` | Filtros: `accountId, status, page` |
| GET | `/stats/summary` | Totales por cuenta/mes: correos, archivos, bytes |
| GET | `/health` | Estado API, BD, Redis |

### Convenciones de respuesta
```json
// Éxito listado
{ "data": [...], "meta": { "page": 1, "limit": 50, "total": 1240 } }
// Error
{ "statusCode": 422, "error": "IMAP_AUTH_FAILED",
  "message": "Autenticación rechazada por imap.gmail.com" }
```

## 8. Seguridad

- **Credenciales**: AES-256-GCM con clave de 32 bytes en `ENCRYPTION_KEY` (env). Formato almacenado: `base64(iv):base64(authTag):base64(cipher)`. La clave nunca se persiste en BD ni en logs.
- **IMAP**: TLS obligatorio (`secure: true` o STARTTLS); rechazar certificados inválidos (sin `rejectUnauthorized: false`).
- **Gmail / Microsoft 365**: documentar uso de app passwords (requiere 2FA activado). OAuth2 en fase 2.
- **Path traversal**: toda ruta de descarga se resuelve con `path.resolve` y se verifica `startsWith(STORAGE_ROOT)`.
- **API Key**: comparación en tiempo constante (`crypto.timingSafeEqual`).
- **Rate limit**: `@nestjs/throttler`, 100 req/min por key.

## 9. Variables de entorno (`.env.example`)

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://maildte:secret@postgres:5432/maildte
REDIS_URL=redis://redis:6379
ENCRYPTION_KEY=            # 32 bytes hex (openssl rand -hex 32)
API_KEY=                   # openssl rand -hex 24
STORAGE_ROOT=/data/storage
DEFAULT_SYNC_INTERVAL=300
TZ_FOLDER=America/El_Salvador
LOG_LEVEL=info
MAX_ATTACHMENT_MB=25
```

## 10. Docker Compose (esqueleto)

```yaml
services:
  api:
    build: .
    command: node dist/main.js
    env_file: .env
    depends_on: [postgres, redis]
    volumes: ["storage:/data/storage"]
  worker:
    build: .
    command: node dist/worker.js
    env_file: .env
    depends_on: [postgres, redis]
    volumes: ["storage:/data/storage"]
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: maildte
      POSTGRES_USER: maildte
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes: ["pgdata:/var/lib/postgresql/data"]
  redis:
    image: redis:7-alpine
    volumes: ["redisdata:/data"]
volumes:
  storage:
  pgdata:
  redisdata:
```

Nginx (host) hace proxy a `api:3000` con TLS (Certbot), como el resto del ecosistema LTSOFT.

## 11. Decisiones de arquitectura (ADR resumido)

| # | Decisión | Alternativa descartada | Razón |
|---|---|---|---|
| ADR-1 | IMAP polling incremental por UID | IMAP IDLE (push) | Simplicidad y robustez multi-proveedor; IDLE requiere conexiones persistentes frágiles. Latencia de 5 min es aceptable. Evaluable en fase 2. |
| ADR-2 | Filesystem + rutas en BD | Archivos como BLOB en PostgreSQL | Los DTE se consultan también por carpeta directamente (contabilidad); respaldo con rsync trivial; BD liviana. |
| ADR-3 | `imapflow` | `node-imap` | API moderna con promesas, mantenimiento activo, manejo nativo de UIDVALIDITY. |
| ADR-4 | Procesamiento secuencial por cuenta, paralelo entre cuentas | Paralelo total | Orden garantizado de lastUid y memoria acotada; el paralelismo entre cuentas ya da el throughput necesario. |
| ADR-5 | monthFolder por fecha de **recepción** | Por fecha de procesamiento | Alineado a períodos fiscales: un correo de julio procesado el 2 de agosto pertenece a julio. |
| ADR-09.1 | Perfil de correo por **referencia viva** (`EmailAccount.providerId` → `MailProvider`, resuelto en cada sync) | Snapshot: copiar host/puerto/TLS a la cuenta al crearla | Corregir un host mal cargado se aplica solo, en la siguiente ronda de todas las cuentas vinculadas. El costo es que un error del SUPERADMIN es un incidente multi-tenant, y se paga con: FK `onDelete: Restrict`, confirmación del número exacto de cuentas para cambiar el endpoint, endpoint de verificación TCP/TLS, y `active: false` como mecanismo de retiro en vez del DELETE. |
| ADR-09.2 | `providerId` **nullable**: NULL = servidor personalizado | Perfil obligatorio, o perfiles privados por tenant | Un cPanel de un hosting local es de un solo cliente y no tiene sentido publicarlo en un catálogo global. Las columnas `imapHost/imapPort/imapSecure` se conservan en `EmailAccount` para ese camino, lo que además hizo la migración no destructiva. Perfiles privados por tenant exigirían `tenantId` + RLS en el catálogo y duplicarían la UI sin resolver nada que este camino no resuelva. |
| ADR-09.3 | Detección por dominio exacto y, si falla, por **registro MX** (`dns.promises`, sin dependencia nueva) | Solo tabla de dominios; o autoconfig de Thunderbird | Sin MX, la detección acierta en gmail.com pero falla en el caso central: PYMEs con dominio propio sobre Google Workspace o Microsoft 365. Autoconfig agrega una dependencia HTTP externa en el camino del alta. Se cachea la **respuesta DNS**, no el perfil resuelto, para que agregar un sufijo al catálogo aplique al instante. |
| ADR-10.1 | Ledger de parseo (`dte_parse_results`, una fila por adjunto JSON) separado del documento | Una columna `parseStatus` en `purchase_documents` | La tabla de documentos queda con solo CCF válidos: ningún listado, total ni export tiene que excluir filas de error. Además modela el duplicado, que no es un estado del documento sino del adjunto: el mismo DTE llega a dos buzones del tenant y el segundo apunta al canónico. Los tipos distintos de `03` quedan registrados con su `tipoDte`, así incorporar notas de crédito/débito después no exige cambio de esquema. |
| ADR-10.2 | Catálogo de partes (`dte_parties`) **más** snapshot de nombre/NIT en el documento | Solo el catálogo, con join en cada consulta | La columna F del anexo es el nombre del proveedor **al momento de la emisión**: si el proveedor cambia de razón social, un anexo reimpreso no puede cambiar retroactivamente. El catálogo aparte es lo que hace posible filtrar por receptor (un buzón recibe DTE de varios clientes) y guardar los defaults Q–T por cliente. |
| ADR-10.3 | Montos en `Decimal(18,8)`, redondeo HALF_UP a 2 decimales solo al exportar | `Float`/`Double`, o redondear al ingerir | `precioUni` llega con 8 decimales en documentos reales. Redondear al ingerir pierde el dato original y `Float` descuadra el anexo centavo a centavo contra la declaración. La conversión desde el JSON pasa por un único punto (`toDecimal`) y nunca por aritmética de `number`. |
| ADR-10.4 | Catálogos de Hacienda (Q–T, tipos de documento, formas de pago) como const maps en TypeScript | Tablas de catálogo en la base | Son listas cerradas definidas por el Ministerio, iguales para todos los tenants y que nadie edita desde la app. Como tablas exigirían seeds, migraciones por cada cambio del instructivo y una pantalla de administración que nadie usaría. |
| ADR-10.5 | Clasificación Q–T: override del documento > default del receptor > sin clasificar | Clasificar cada compra a mano, o un valor fijo por tenant | Esas cuatro columnas no existen en el DTE: son criterio contable. El default por receptor cubre el caso normal (todas las compras de un cliente se clasifican igual) sin impedir corregir la compra puntual que es distinta. El export **se bloquea** si queda alguna sin resolver: nunca se inventa un código para completar la fila. |
| ADR-10.6 | XLSX con `write-excel-file` | `exceljs`; `xlsx` de SheetJS | Ambas alternativas están descartadas por vulnerabilidades sin parche: `xlsx` 0.18.5 (npm) arrastra CVE-2023-30533 y CVE-2024-22363 y está abandonada en el registry; `exceljs` 4.4.0 no publica desde 2024-12 y tiene CVE-2026-78207 (prototype pollution, CVSS 9.4) corregida solo en un fork. `write-excel-file` es MIT, tiene una sola dependencia y ningún advisory. Fallback documentado: escritor OOXML propio sobre `archiver`, que ya está en el árbol. |
| ADR-10.7 | Validación del JSON con narrowing manual | `zod` u otro validador de esquemas | La forma consumida es chica y debe ser **tolerante**: campos extra se ignoran y los alias v3/v4 conviven. Un esquema exigiría `passthrough` en todos lados y uniones por cada alias, y devolvería errores en inglés. El narrowing manual da errores en español con la ruta del campo (`resumen.totalGravada: campo obligatorio ausente`) y cero dependencias. |
| ADR-10.8 | `fecEmi` como `DATE`; `rawJson` como `jsonb` | `timestamp` con hora; no guardar el JSON crudo | `fecEmi` es una fecha calendario emitida sin zona: como `timestamp` cualquier conversión la corre un día. `rawJson` permite mostrar el documento original y re-normalizar sin volver a leer disco; su costo son unos pocos KB por compra. |
| ADR-10.9 | Columna O del anexo = **suma de G a M**, sin el crédito fiscal de N | `G + J + N`, que coincide con `montoTotalOperacion` en las muestras | O es el total gravado **neto** y N es el impuesto que esa compra genera: sumarlos daría el monto con IVA incluido y duplicaría el impuesto en el total del anexo. El instructivo lo delimita: "el total de las operaciones detalladas en las columnas comprendidas de la G a la M". La coincidencia numérica con `montoTotalOperacion` era casual y se conserva como verificación (`O + N ≈ montoTotalOperacion`), no como fórmula. |
