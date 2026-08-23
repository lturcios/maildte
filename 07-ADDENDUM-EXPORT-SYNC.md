# Addendum 07 — Módulo Export/Sync Local — MailDTE Collector
**Extensión al SRS y la Arquitectura: descarga incremental o total hacia el entorno local del cliente**

Este documento agrega el requisito **RF-07 (Exportación)**, el diseño del **agente cliente `maildte-pull`** y el **Prompt 3.2** para Claude Code. Es compatible con todo lo existente: no modifica el schema de sync ni el flujo IMAP; solo lee.

---

## 1. Concepto

El estado de sincronización vive **en el cliente** (cursor local), no en el servidor:

```
"nuevos" = archivos con createdAt > cursor local del cliente
"todos"  = pull con cursor = 0 (el hash evita re-escrituras reales)
```

Ventajas de este diseño:
- N clientes/máquinas sincronizan la misma cuenta de forma independiente, sin tablas de tracking por cliente en el VPS.
- Idempotente y reanudable: un pull interrumpido se retoma sin duplicar (verificación por SHA-256 ya registrado en BD).
- El servidor queda stateless respecto a exportaciones: solo sirve manifiesto y archivos.

## 2. Secuencia completa

```
┌────────────┐  IMAP   ┌─────────────────────┐
│ Buzones    ├────────►│ VPS: worker + API   │
└────────────┘         │ STORAGE_ROOT + BD   │
                       └─────────┬───────────┘
                                 │ HTTPS (X-Api-Key)
                     1. GET /export/manifest?accountId&since=cursor
                     2. compara vs estado local (.maildte-state.json)
                     3. GET /attachments/:id/download  (por faltante)
                        ó GET /export/archive (ZIP por lote)
                     4. verifica sha256 → escribe con misma estructura
                     5. actualiza cursor local
                                 ▼
                       ┌─────────────────────┐
                       │ PC/Servidor cliente │
                       │ carpeta_local/      │
                       │ └ cuenta/2026-08/…  │
                       └─────────────────────┘
```

## 3. RF-07 — Requisitos funcionales de exportación

### Lado servidor (API)
- **RF-07.1 — Manifiesto**: `GET /api/v1/export/manifest` con parámetros:
  - `accountId` (requerido)
  - `since` (ISO 8601 opcional; omitido = todos) — filtra por `Attachment.createdAt > since`
  - `month` (opcional, `YYYY-MM`) — filtra por `ProcessedEmail.monthFolder`
  - Paginado por cursor (`cursorId`, `limit` máx 1000), orden `createdAt asc, id asc` (orden total estable).
  - Retorna por archivo: `attachmentId, relativePath, fileType, sizeBytes, sha256, createdAt, receivedAt, senderEmail` y `meta: { nextCursor, maxCreatedAt, totalFiles, totalBytes }`.
- **RF-07.2 — Descarga individual**: reutiliza `GET /attachments/:id/download` existente (RF-05.3), sin cambios.
- **RF-07.3 — Descarga por lote (ZIP)**: `GET /api/v1/export/archive` con los mismos filtros del manifiesto. Genera ZIP **en streaming** (sin materializarlo en disco ni memoria completa) preservando la estructura interna `{folderName}/{YYYY-MM}/{json|pdf}/{archivo}`. Límite configurable `EXPORT_MAX_ZIP_FILES` (default 5000); si el filtro excede el límite → 422 `EXPORT_TOO_LARGE` con instrucción de acotar por mes o usar manifiesto+individual.
- **RF-07.4 — Integridad**: el manifiesto es la fuente de verdad de hashes; el cliente valida cada archivo contra `sha256`. El ZIP incluye en su raíz `manifest.json` con la misma información para verificación offline.
- **RF-07.5 — Solo lectura**: ningún endpoint de export modifica estado en el servidor. Los archivos con registro en BD pero ausentes en disco se listan en el manifiesto con flag `missing: true` y se omiten del ZIP (contados en `meta.missingFiles`).

### Lado cliente (agente `maildte-pull`)
- **RF-07.6**: CLI Node distribuible (binario único vía `pkg` o ejecución con Node 20) con comandos:
  - `maildte-pull init` — configura interactivamente URL, API key, carpeta destino y cuentas (guarda `maildte.config.json`; la key con permisos 600).
  - `maildte-pull sync` — descarga **solo nuevos** (desde el cursor local) de todas las cuentas configuradas.
  - `maildte-pull sync --all` — **todos** los archivos (cursor ignorado; los existentes con hash válido se saltan).
  - `maildte-pull sync --account compras@ltsoft.us --month 2026-07` — filtros.
  - `maildte-pull verify` — re-hashea el árbol local contra el manifiesto completo y reporta faltantes/corruptos sin descargar.
- **RF-07.7**: replica exactamente la estructura del servidor bajo la carpeta destino. Escritura atómica local (tmp + rename), verificación de hash post-descarga; hash inválido → reintento (máx 3) y reporte.
- **RF-07.8**: estado local en `.maildte-state.json` dentro de la carpeta destino: `{ [accountId]: { cursor: maxCreatedAt } }`. El cursor solo avanza cuando **todo** el lote quedó verificado.
- **RF-07.9**: salida clara en español: resumen por cuenta (nuevos, ya existentes, descargados, MB, errores) y código de salida ≠ 0 ante cualquier fallo (apto para tareas programadas con alerta).
- **RF-07.10**: concurrencia de descarga configurable (default 4), reintentos con backoff ante errores de red, y `--dry-run` que muestra qué se descargaría.

### Reglas de decisión de estrategia (automática en el cliente)
```
≤ 200 archivos nuevos  → descargas individuales concurrentes (reanudable fino)
> 200 archivos nuevos  → ZIP por lote(s) mensuales vía /export/archive
--all inicial          → ZIP por mes, iterando meses del manifiesto
```

## 4. Cambios en el servidor

- **Nuevo módulo `export/`** (`export.module.ts`, `export.controller.ts`, `export.service.ts`) — solo lectura, consume Prisma + `StorageService.resolveSafe`.
- **Dependencia nueva justificada**: `archiver` (ZIP streaming). Registrar la justificación según regla 3 de CLAUDE.md.
- **Sin cambios de schema**: `Attachment.createdAt` + índice existente son suficientes. Agregar índice compuesto si el volumen lo pide: `@@index([createdAt, id])` en `Attachment` (migración `export_cursor_index`).
- **Throttling**: `/export/archive` con `@Throttle` propio (10 req/min) por costo de CPU/IO.
- `.env` nuevo: `EXPORT_MAX_ZIP_FILES=5000`.

## 5. Seguridad

- Mismos mecanismos existentes: `X-Api-Key`, TLS vía Nginx, validación `resolveSafe` en cada archivo empaquetado.
- Opcional recomendado si habrá múltiples clientes externos: **API keys con scope por cuenta** (tabla `ApiClient { id, name, keyHash, allowedAccountIds[] }`); el guard resuelve el cliente y el módulo export filtra `accountId ∈ allowedAccountIds`. Se especifica como RF-07.11 opcional; si solo el propio cliente/contador accede, la key global del MVP basta.
- La API key jamás se pasa por query string (solo header), para que no quede en logs de Nginx.

## 6. Alternativas descartadas (ADR-6)

| Alternativa | Razón de descarte |
|---|---|
| rsync sobre SSH | Requiere cuentas SSH en el VPS por cliente, sin control de scope por cuenta de correo, fuera del modelo API key; queda como herramienta interna de respaldo, no de entrega a clientes |
| Syncthing/Dropbox/rclone | Dependencia externa no controlada por la app; sin manifiesto verificable ni filtros por cuenta/mes |
| Estado de exportación en el servidor (lastExportAt por cliente) | Obliga a registrar cada máquina cliente y rompe con múltiples destinos por cliente; el cursor local es más simple y más robusto |
| WebSocket/push al cliente | Innecesario: la frecuencia natural es horaria/diaria; pull programado es más simple y atraviesa NAT/firewalls sin configuración |

## 7. Prompt 3.2 para Claude Code (insertar tras el Prompt 3.1)

```
Lee CLAUDE.md y el addendum 07 (RF-07). Skills a aplicar:
api-conventions, data-layer, atomic-storage (resolveSafe),
testing-maildte.

Parte A — servidor:
1. Módulo export/ de solo lectura:
   - GET /api/v1/export/manifest con filtros accountId (requerido),
     since, month; paginación por cursor (createdAt asc, id asc como
     desempate) limit máx 1000; retorna attachmentId, relativePath,
     fileType, sizeBytes, sha256, createdAt, receivedAt, senderEmail,
     missing (existsSync sobre resolveSafe) y meta { nextCursor,
     maxCreatedAt, totalFiles, totalBytes, missingFiles }.
   - GET /api/v1/export/archive con los mismos filtros: ZIP en
     streaming con archiver preservando la estructura
     folderName/YYYY-MM/json|pdf/, manifest.json en la raíz del ZIP,
     omitiendo missing; si el conteo supera EXPORT_MAX_ZIP_FILES →
     422 EXPORT_TOO_LARGE. Throttle propio 10 req/min.
   - Migración export_cursor_index: @@index([createdAt, id]) en
     Attachment.
   - Justificar archiver como dependencia nueva según CLAUDE.md.
2. Tests: manifiesto con since filtra exacto por createdAt, paginación
   estable sin huecos ni repetidos entre páginas, archivo borrado de
   disco aparece missing:true y no rompe el ZIP, filtro month, y
   e2e del ZIP: descomprimir y verificar estructura + manifest.json.

Parte B — cliente CLI (carpeta cli/ como paquete independiente, pnpm,
TypeScript strict, sin dependencias de NestJS):
3. maildte-pull con comandos init, sync [--all] [--account]
   [--month] [--dry-run], verify según RF-07.6 a RF-07.10:
   estado .maildte-state.json con cursor por cuenta que solo avanza
   con lote 100% verificado, escritura atómica local, verificación
   sha256 con 3 reintentos, concurrencia 4, estrategia automática
   individual vs ZIP (umbral 200), salida en español con resumen por
   cuenta y exit code ≠ 0 ante fallos.
4. Tests del CLI con la API mockeada (msw o servidor http local de
   test): sync incremental avanza cursor solo si todo verificó,
   --all salta existentes con hash válido, hash corrupto reintenta y
   reporta, --dry-run no escribe nada.
5. README del CLI: instalación, configuración de tarea programada en
   Windows (schtasks) y cron en Linux/macOS, ejemplo de salida.
```

## 8. Impacto en el plan

| Fase | Cambio |
|---|---|
| Fase 3 | +1 día: se agrega el Prompt 3.2 (servidor export + CLI) |
| Fase 4 | RUNBOOK.md agrega sección: instalación del agente en el equipo del cliente y verificación de la tarea programada |
| Estimación total MVP | 6–7.5 días |
