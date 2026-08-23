# Plan de Implementación por Fases — MailDTE Collector
Cada fase es autocontenida, termina en estado desplegable y tiene su prompt para Claude Code. Antes de cada fase, colocar en el repo: `CLAUDE.md`, `03-ARQUITECTURA-TECNICA.md` y este plan.

---

## Fase 0 — Scaffold y fundaciones (0.5 día)

**Entregables**: proyecto NestJS 10 con TS strict, Prisma inicializado con el schema completo de `03-ARQUITECTURA`, migración inicial, `ConfigModule` con validación Joi de env, `PrismaService`, `AesService` (AES-256-GCM) con tests, `sanitizeFilename` con tests, `ApiKeyGuard`, filtro global de excepciones, pino, Docker Compose (postgres + redis), `.env.example`.

**Prompt Claude Code:**
> Lee CLAUDE.md y 03-ARQUITECTURA-TECNICA.md. Crea el scaffold del proyecto MailDTE: NestJS 10 con TypeScript strict y pnpm, estructura de carpetas de la sección 3 de la arquitectura, schema.prisma completo de la sección 4 con su migración inicial, ConfigModule con validación Joi de todas las variables de .env.example, PrismaService, AesService con AES-256-GCM (formato iv:tag:cipher en base64) con unit tests de cifrado/descifrado, utilidad sanitizeFilename con tests de los casos: caracteres inválidos, longitud >180, extensión preservada. Incluye ApiKeyGuard con timingSafeEqual, filtro global de excepciones con el formato de error de la sección 7, logger pino y docker-compose con postgres:16-alpine y redis:7-alpine. Verifica pnpm build y pnpm test antes de terminar.

**Criterio de salida**: `docker compose up` + `pnpm start:dev` levanta y `/api/v1/health` responde.

---

## Fase 1 — Gestión de cuentas (1 día)

**Entregables**: módulo `accounts` completo (CRUD + soft delete + test de conexión IMAP), `ImapClientFactory`, normalización de `folderName`, creación de carpeta base en storage al dar de alta.

**Prompt Claude Code:**
> Implementa el módulo accounts según RF-01 del SRS: POST /accounts valida la conexión IMAP con imapflow antes de persistir (timeout 15s, errores diferenciados: auth, host, TLS), cifra la contraseña con AesService, calcula folderName normalizado (lowercase, @ y . a _) y crea la carpeta base en STORAGE_ROOT. GET nunca retorna imapPassEnc. PATCH revalida IMAP si cambian credenciales. DELETE es soft delete (deletedAt). Agrega POST /accounts/:id/test. DTOs con class-validator. Unit tests del service con ImapFlow mockeado: alta exitosa, fallo de auth, normalización de folderName.

**Criterio de salida**: puedo dar de alta una cuenta Gmail con app password y el test de conexión pasa.

---

## Fase 2 — Motor de sincronización (2–3 días) ⭐ núcleo

**Entregables**: `sync.scheduler` (jobs repetibles BullMQ por cuenta activa), `sync.processor` en proceso worker separado (`worker.ts`), `sync.service` con el flujo completo de la sección 5 de la arquitectura, `message-parser` (mailparser), `storage.service` (monthFolder con TZ, escritura atómica, hash, colisiones), `SyncLog`, lock Redis, reintentos con backoff, manejo de `uidValidity` y `ERROR_AUTH`.

**Prompt Claude Code (dividir en 2 sesiones):**
>
> **2a**: Implementa StorageService según RF-04 y sección 6 de la arquitectura: resolveMonthFolder(receivedAt) usando TZ America/El_Salvador (un solo punto de conversión), saveAttachment(buffer|stream, account, monthFolder, originalName) con escritura atómica tmp+fsync+rename, cálculo SHA-256, resolución de colisiones (mismo hash → reutilizar ruta; distinto → sufijo _8chars), limpieza de .tmp huérfanos, validación anti path-traversal. Unit tests: borde de mes en UTC vs El Salvador (correo 2026-09-01T03:00Z debe caer en carpeta 2026-08), colisión con hash igual y distinto, sanitización.
>
> **2b**: Implementa el motor de sincronización según la sección 5 de la arquitectura y RF-02/RF-03: SyncScheduler registra jobs repetibles BullMQ por cuenta ACTIVA al bootstrap y al crear/actualizar cuentas; worker.ts como proceso independiente consume la cola con concurrencia 3; SyncService ejecuta el flujo completo con lock Redis SET NX TTL 10min, conexión imapflow readOnly, fetch incremental por UID, verificación uidValidity, idempotencia por (accountId, messageId), filtrado OR extensión/MIME, transacción Prisma por correo con rollback de archivos en disco si falla, lastUid actualizado por correo, SyncLog con contadores, reintentos BullMQ attempts:3 backoff exponencial 30s, ERROR_AUTH tras 3 fallos de auth consecutivos. Endpoint POST /accounts/:id/sync encola job manual (trigger: "manual"). Tests del service con ImapFlow y Prisma mockeados: correo duplicado se omite, fallo individual no aborta lote, sin adjuntos registra SIN_ADJUNTOS.

**Criterio de salida**: correo real enviado a la cuenta de prueba con un JSON y un PDF aparece en `storage/{cuenta}/{mes}/json|pdf/` en menos del intervalo configurado, con registro completo en BD. Reenviar el mismo correo no genera duplicados.

---

## Fase 3 — Consulta, auditoría y estadísticas (1 día)

**Entregables**: módulos `emails` y `stats` (RF-05), descarga por stream con nombre original, paginación, filtros combinables, listado de SyncLogs.

**Prompt Claude Code:**
> Implementa los módulos emails y stats según RF-05 y la tabla de API de la sección 7: GET /emails con filtros combinables accountId, from, to, sender (contains case-insensitive sobre senderEmail y senderName), status, hasAttachments, paginación offset limit 50 y meta {page, limit, total}; GET /emails/:id con adjuntos; GET /attachments/:id/download con stream desde disco, validación de que la ruta resuelta está dentro de STORAGE_ROOT y Content-Disposition con originalName; GET /sync-logs con filtros; GET /stats/summary con agregados por cuenta y monthFolder: correos, archivos, bytes (usar groupBy de Prisma). E2E tests con supertest de los filtros principales y del path traversal (debe retornar 400).

**Criterio de salida**: el flujo del CU-03 (consulta contable mensual) funciona de punta a punta.

---

## Fase 4 — Despliegue y hardening (0.5–1 día)

**Entregables**: Dockerfile multi-stage (build → runtime node:20-alpine usuario no root), compose de producción con ambos procesos, Nginx con TLS, throttling, healthchecks, script de respaldo (rsync storage + pg_dump), documentación de habilitación de app passwords Gmail/M365, runbook de operación.

**Prompt Claude Code:**
> Prepara el despliegue: Dockerfile multi-stage con pnpm y usuario uid 1000, docker-compose.prod.yml con servicios api y worker desde la misma imagen, healthcheck del api contra /api/v1/health, @nestjs/throttler 100 req/min, configuración Nginx de ejemplo con proxy y TLS, script bash de respaldo diario (pg_dump + rsync de STORAGE_ROOT con retención 30 días) y RUNBOOK.md con: alta de cuenta Gmail/M365 con app password paso a paso, qué hacer ante ERROR_AUTH, cómo reprocesar desde una fecha (reset de lastUid + syncFromDate), cómo verificar logs del worker.

**Criterio de salida**: sistema corriendo en el VPS con al menos 2 cuentas reales sincronizando.

---

## Fase 5 (opcional, post-MVP) — Panel web y metadatos DTE

- **5a Panel**: React 19 + Vite + Tailwind + shadcn/ui + Zustand. Vistas: dashboard (stats), cuentas (CRUD + estado + botón sync), correos (tabla con filtros + descarga), logs. Auth por API key almacenada en Zustand persist.
- **5b Metadatos DTE**: al procesar un JSON, intentar parsear estructura DTE MH (identificacion.codigoGeneracion, tipoDte, emisor.nit, emisor.nombre, resumen.totalPagar, fecEmi). Nueva tabla `DteMetadata` relacionada a `Attachment`, tolerante a JSON no-DTE (parseo best-effort, nunca falla el sync). Filtros nuevos en /emails por NIT emisor y tipoDte.

---

## Estimación total MVP

| Fase | Duración |
|---|---|
| 0 — Scaffold | 0.5 día |
| 1 — Cuentas | 1 día |
| 2 — Sincronización | 2–3 días |
| 3 — Consulta | 1 día |
| 4 — Despliegue | 0.5–1 día |
| **Total** | **5–6.5 días** |

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Gmail bloquea IMAP básico | App passwords documentados desde fase 1; OAuth2 planificado en fase 5 |
| UIDVALIDITY reset (migración de buzón) | Manejado por diseño: reset lastUid + idempotencia por messageId |
| Adjuntos DTE en ZIP (algunos emisores) | Fuera del MVP; detectarlos y registrarlos como SIN_ADJUNTOS con nota; soporte ZIP evaluado en fase 5 |
| Disco lleno | Alerta en stats (bytes totales), respaldo con retención, monitoreo del VPS |
| Correos masivos históricos en primera sync | syncFromDate limita el arranque; procesamiento secuencial acota memoria |
