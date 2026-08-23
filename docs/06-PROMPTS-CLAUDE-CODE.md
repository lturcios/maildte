# Prompts para Claude Code — MailDTE Collector (v2, con skills)
Colección secuencial. Ejecutar en orden. Requisitos previos en el repo:
- Raíz: `CLAUDE.md`, `01-PRD-MailDTE.md`, `02-SRS-MailDTE.md`, `03-ARQUITECTURA-TECNICA.md`
- `.claude/skills/` con las 6 skills del proyecto (ver `skills/README.md`)

**Cómo usan las skills estos prompts**: cada prompt declara las skills relevantes al inicio y delega en ellas el detalle de implementación (patrones de código, trampas conocidas, checklists de tests). El prompt define el QUÉ y los criterios de aceptación; las skills definen el CÓMO. Esto mantiene los prompts cortos, evita contradicciones entre sesiones y garantiza que cada sesión aplique exactamente los mismos patrones.

---

## Prompt 0.1 — Scaffold del proyecto

```
Lee CLAUDE.md. Skills a aplicar en esta sesión: data-layer,
api-conventions, testing-maildte.

Crea el scaffold de MailDTE Collector según las secciones 3, 4, 9 y 10
de 03-ARQUITECTURA-TECNICA.md:

1. NestJS 10 + TypeScript strict + pnpm, estructura de carpetas de la
   sección 3.
2. schema.prisma completo de la sección 4 + migración inicial "init"
   (skill data-layer: reglas de migración y el constraint de
   idempotencia que jamás se relaja).
3. ConfigModule con validación Joi de todo .env.example: si falta una
   variable, el proceso no arranca.
4. PrismaService, AesService (AES-256-GCM, formato iv:tag:cipher
   base64), sanitizeFilename (patrón exacto en skill atomic-storage),
   ApiKeyGuard y filtro global de excepciones (formato y comparación
   timing-safe según skill api-conventions).
5. Logger pino, docker-compose (postgres:16-alpine, redis:7-alpine),
   scripts pnpm: start:dev, start:worker:dev, build, test, lint.
6. GET /api/v1/health (público) verificando BD y Redis.

Tests de esta fase: los casos de AesService y sanitizeFilename del
checklist de la skill testing-maildte.

Aceptación: docker compose up + pnpm start:dev levanta, /health
responde, pnpm build/lint/test pasan.
```

---

## Prompt 1.1 — Módulo de cuentas

```
Lee CLAUDE.md y RF-01 del 02-SRS-MailDTE.md. Skills a aplicar:
imap-sync, data-layer, api-conventions, testing-maildte.

Implementa el módulo accounts:

1. ImapClientFactory en sync/imap/ con el patrón de conexión y la
   taxonomía de errores de la skill imap-sync (TLS obligatorio,
   timeouts, códigos IMAP_AUTH_FAILED / IMAP_HOST_UNREACHABLE /
   IMAP_TLS_ERROR).
2. POST /accounts: valida conexión IMAP real antes de persistir
   (timeout 15 s, errores diferenciados → 422 con el formato de la
   skill api-conventions). Si pasa: cifra credencial, calcula
   folderName normalizado (regla en skill atomic-storage) y crea la
   carpeta base en STORAGE_ROOT.
3. GET /accounts y /accounts/:id con select seguro (skill data-layer:
   imapPassEnc jamás sale). El detalle incluye últimas 5
   sincronizaciones.
4. PATCH: revalida IMAP si cambian credenciales; ERROR_AUTH → ACTIVA
   si la validación pasa. DELETE: soft delete según skill data-layer.
5. POST /accounts/:id/test → { ok, latencyMs } o error diferenciado.
6. DTOs con class-validator: email válido, puerto 1-65535,
   syncInterval mínimo 60.

Tests: sección AccountsService del checklist de testing-maildte,
con el mock de ImapFlow de esa skill.

Aceptación: alta de una cuenta Gmail con app password funciona y el
fallo de auth retorna 422 sin persistir nada.
```

---

## Prompt 2.1 — StorageService

```
Lee CLAUDE.md y RF-04 del SRS. Skill principal: atomic-storage
(contiene los patrones exactos: síguelos literalmente). Skill de
apoyo: testing-maildte.

Implementa storage/storage.service.ts con la API:

- resolveMonthFolder(receivedAt) — implementación de referencia en la
  skill; único punto de conversión de TZ del sistema.
- saveAttachment({ content, account, monthFolder, originalName,
  mimeType }) → { storedName, relativePath, sizeBytes, sha256, reused }
  con: subcarpeta json|pdf, sanitización, hash (streaming > 5 MB),
  resolución de colisiones y escritura atómica según la skill.
- resolveSafe(relativePath) — validación anti path-traversal
  reutilizable por el módulo de descargas.
- cleanOrphanTmp(folderName) y deleteFiles(relativePaths[]) con la
  semántica de rollback de la skill (nunca borrar reused).

Tests: sección StorageService completa del checklist de
testing-maildte, sobre directorio temporal real (fs.mkdtemp).

Aceptación: todos los casos del checklist en verde, incluido el borde
de mes 2026-09-01T03:00:00Z → "2026-08".
```

---

## Prompt 2.2 — Motor de sincronización

```
Lee CLAUDE.md, RF-02/RF-03 del SRS y la sección 5 de la arquitectura
(flujo maestro). Skills a aplicar: imap-sync, queues-worker,
data-layer, testing-maildte. Este es el núcleo del sistema: el flujo
de la sección 5 manda; las skills dan los patrones de cada paso.

1. sync.scheduler.ts en el proceso API: jobs repetibles por cuenta
   ACTIVA con jobId determinístico y sincronización de jobs ante
   crear/actualizar/desactivar cuentas (patrones y reglas de limpieza
   de repetibles huérfanos en skill queues-worker).
2. src/worker.ts standalone con concurrencia 3 (skill queues-worker).
3. sync.service.ts implementa la sección 5 usando:
   - Lock Redis con liberación segura y caso "ocupado" como flujo
     normal (queues-worker).
   - Conexión, fetch incremental con guard de UID del rango n:*,
     manejo de UIDVALIDITY y parseo con fallback de messageId
     (imap-sync — atención a las trampas documentadas).
   - Filtrado OR extensión/MIME y clasificación JSON|PDF (imap-sync).
   - Adjuntos > MAX_ATTACHMENT_MB: omitir con WARN y nota en
     errorDetail del correo.
   - Persistencia con la transacción correo+adjuntos, manejo de P2002
     como duplicado y lastUid por correo (data-layer).
   - Rollback en disco vía deleteFiles ante fallo de transacción.
   - Ciclo de vida completo de SyncLog y contadores (queues-worker).
4. Reintentos, clasificación de errores transitorios vs por-correo y
   transición a ERROR_AUTH con contador Redis (queues-worker).
5. POST /accounts/:id/sync encola job manual (422 si INACTIVA o
   ERROR_AUTH).
6. Logs pino con contexto { accountId, syncId } en todo el flujo.

Tests: sección SyncService completa del checklist de testing-maildte,
usando imapFlowMock y fakeRawEmail (MIME real, mailparser sin mockear).

Aceptación: correo real con un JSON y un PDF enviado a la cuenta de
prueba aparece en storage/{cuenta}/{mes}/json|pdf/ con registro
completo en BD; reenviar el mismo correo no duplica nada; matar el
worker a mitad de un lote y reiniciar no repite ni pierde correos.
```

---

## Prompt 3.1 — Consulta, auditoría y estadísticas

```
Lee CLAUDE.md y RF-05 del SRS. Skills a aplicar: api-conventions,
data-layer, atomic-storage (resolveSafe), testing-maildte.

Implementa los módulos emails y stats según la tabla de API de la
sección 7 de la arquitectura:

1. GET /emails con el DTO de listado de la skill api-conventions
   (filtros combinables, clamp de limit) y la paginación en
   transacción de la skill data-layer. Orden receivedAt desc.
2. GET /emails/:id con adjuntos.
3. GET /attachments/:id/download con el patrón exacto de descarga de
   api-conventions: stream, resolveSafe → 400, archivo ausente → 410
   FILE_MISSING, Content-Disposition UTF-8.
4. GET /sync-logs con filtros y paginación.
5. GET /stats/summary con agregaciones groupBy en PostgreSQL (skill
   data-layer: nunca agregar en JS): totales por cuenta, por
   cuenta+monthFolder últimos 12 meses, últimos 10 SyncLog en ERROR.

Tests: sección E2E del checklist de testing-maildte con supertest y
BD de test en docker.

Aceptación: CU-03 del SRS (consulta contable mensual) funciona de
punta a punta, incluida la descarga con nombre original con tildes.
```

---

## Prompt 4.1 — Despliegue y hardening

```
Lee CLAUDE.md y las secciones 8, 9 y 10 de la arquitectura. Skills a
aplicar: api-conventions (throttling), data-layer (migrate deploy).

1. Dockerfile multi-stage (pnpm --frozen-lockfile + prisma generate;
   runtime node:20-alpine, usuario uid 1000).
2. docker-compose.prod.yml: api y worker desde la misma imagen,
   volumen storage compartido, healthcheck contra /health,
   restart unless-stopped, prisma migrate deploy al arrancar el api.
3. Throttler global 100 req/min según skill api-conventions.
4. nginx/maildte.conf: proxy a api:3000, TLS Certbot,
   client_max_body_size 30m.
5. scripts/backup.sh: pg_dump comprimido + rsync incremental de
   STORAGE_ROOT, retención 30 días, apto para cron, sin detener
   servicios.
6. RUNBOOK.md en español: alta Gmail/M365/cPanel con app password
   paso a paso, procedimiento ante ERROR_AUTH (coherente con la
   transición documentada en la skill queues-worker), reprocesar un
   período (reset lastUid + syncFromDate; la idempotencia evita
   duplicados), lectura de logs del worker, restauración desde
   respaldo.

Aceptación: sistema corriendo en el VPS con 2 cuentas reales
sincronizando y respaldo diario verificado.
```

---

## Prompt 5.1 (opcional) — Panel web

```
Lee CLAUDE.md. Skill de apoyo: api-conventions (contratos de
respuesta y error que el cliente debe consumir).

Crea el panel en web/ como proyecto independiente: React 19 + Vite +
TypeScript strict + Tailwind + shadcn/ui + Zustand, pnpm.

Vistas: Dashboard (cards de totales + últimos errores + gráfica
recharts de correos por mes desde /stats/summary), Cuentas (tabla con
badge por estado, alta/edición en Dialog con test de conexión previo,
botón Sincronizar ahora, soft delete con confirmación), Correos
(filtros server-side, paginación con meta de la API, fila expandible
con adjuntos y descarga), Logs (auto-refresh 30 s).

Infraestructura: API key en Zustand persist con pantalla de
configuración inicial, cliente fetch centralizado con X-Api-Key que
parsea el formato de error { statusCode, error, message } de la skill
api-conventions y lo muestra con sonner, UI en español, dark mode,
build estático servido por Nginx en /panel.
```

## Prompt 5.2 (opcional) — Metadatos DTE

```
Lee CLAUDE.md. Skills a aplicar: data-layer (migración y relación),
imap-sync (punto de inserción en el flujo), testing-maildte.

1. Migración: modelo DteMetadata (attachmentId único,
   codigoGeneracion, numeroControl, tipoDte, fecEmi, nitEmisor,
   nombreEmisor, totalPagar Decimal, moneda) relacionado a Attachment.
2. Tras guardar un adjunto JSON en el sync: parseo best-effort de la
   estructura DTE del MH (identificacion.codigoGeneracion, .tipoDte,
   .fecEmi, emisor.nit, emisor.nombre, resumen.totalPagar). JSON
   no-DTE o corrupto: no crea DteMetadata, log DEBUG, jamás falla el
   sync (misma filosofía de fallo aislado de la skill queues-worker).
3. Filtros nitEmisor y tipoDte en GET /emails; GET /stats/dte con
   groupBy por tipoDte y emisor del mes (data-layer: agregación en
   PostgreSQL).
4. Actualiza la skill data-layer agregando el nuevo modelo al mapa de
   responsabilidades (regla de mantenimiento de skills/README.md).

Tests: JSON DTE válido tipo 01 y 03, JSON arbitrario, JSON corrupto.
```

---

## Verificación transversal (todas las sesiones)
1. `pnpm build`, `pnpm lint`, `pnpm test` en verde antes de cerrar.
2. Revisar el diff contra los anti-patrones de CLAUDE.md.
3. Si se descubrió una trampa nueva (proveedor IMAP, mailparser, FS),
   documentarla en la skill correspondiente en el mismo cambio.
