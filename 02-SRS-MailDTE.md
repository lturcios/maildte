# SRS — MailDTE Collector
**Especificación de Requisitos de Software — v1.0**

---

## 1. Requisitos funcionales

### RF-01 — Gestión de cuentas de correo
- **RF-01.1**: El sistema permite registrar cuentas con: alias descriptivo, dirección de correo, host IMAP, puerto, TLS (sí/no), usuario, contraseña/app password, carpeta a monitorear (por defecto `INBOX`) e intervalo de sincronización.
- **RF-01.2**: Al registrar una cuenta, el sistema valida la conexión IMAP antes de guardarla; si falla, retorna el error específico (autenticación, host inalcanzable, TLS).
- **RF-01.3**: Las cuentas pueden activarse/desactivarse sin eliminarlas; una cuenta inactiva no se sincroniza pero conserva su historial.
- **RF-01.4**: Las contraseñas se almacenan cifradas con AES-256-GCM; nunca se retornan en ninguna respuesta de la API (write-only).
- **RF-01.5**: Al eliminar una cuenta se conservan registros y archivos (soft delete); la eliminación física requiere confirmación explícita y es una operación separada.

### RF-02 — Sincronización
- **RF-02.1**: Un scheduler encola un job de sincronización por cada cuenta activa según su intervalo configurado (por defecto 5 min).
- **RF-02.2**: La sincronización es incremental: se consulta solo `UID > lastUid` registrado para la cuenta. En la primera sincronización se procesa desde la fecha configurada en `syncFromDate` (por defecto: fecha de alta de la cuenta).
- **RF-02.3**: Existe un endpoint de sincronización manual inmediata por cuenta (`POST /accounts/:id/sync`).
- **RF-02.4**: No pueden ejecutarse dos sincronizaciones simultáneas de la misma cuenta (lock por cuenta en Redis).
- **RF-02.5**: Cada ejecución genera un registro `SyncLog` con: inicio, fin, correos encontrados, correos procesados, archivos descargados, estado y detalle de error si aplica.
- **RF-02.6**: Ante fallo de conexión, el job se reintenta 3 veces con backoff exponencial (30 s, 2 min, 8 min); agotados los reintentos, el `SyncLog` queda en estado `ERROR` y la cuenta se marca con `lastError`.

### RF-03 — Procesamiento de correos
- **RF-03.1**: Por cada correo nuevo, el sistema extrae: `Message-ID`, `UID`, asunto, nombre del remitente, dirección del remitente, dirección(es) destinatarias, fecha/hora de recepción (header `Date`, normalizada a UTC y convertida a `America/El_Salvador` para la carpeta mensual).
- **RF-03.2**: Se filtran adjuntos cuyo nombre termine en `.json` o `.pdf` (case-insensitive) **o** cuyo MIME sea `application/json` / `application/pdf`. Ambos criterios se evalúan; basta uno.
- **RF-03.3**: Un correo sin adjuntos JSON/PDF se registra con estado `SIN_ADJUNTOS` (queda en el log pero no genera archivos).
- **RF-03.4**: Un correo con adjuntos válidos se registra con estado `PROCESADO` junto con el detalle de cada archivo.
- **RF-03.5**: Si el procesamiento de un correo falla (adjunto corrupto, disco lleno), se registra con estado `ERROR` y detalle; la sincronización continúa con el siguiente correo (fallo aislado no aborta el lote).
- **RF-03.6**: Idempotencia: antes de procesar se verifica que no exista registro con el mismo `(accountId, messageId)`. Si existe, el correo se omite y se contabiliza como duplicado en el `SyncLog`.

### RF-04 — Almacenamiento de archivos
- **RF-04.1**: Estructura obligatoria de carpetas:
  ```
  {STORAGE_ROOT}/
  └── {cuenta-normalizada}/          ← una carpeta por cuenta
      └── {YYYY-MM}/                 ← subcarpeta mensual (fecha de recepción, TZ El Salvador)
          ├── json/
          │   └── {archivo}.json
          └── pdf/
              └── {archivo}.pdf
  ```
- **RF-04.2**: `cuenta-normalizada` = dirección de correo en minúsculas con `@` y `.` reemplazados por `_` (ej. `compras@ltsoft.us` → `compras_ltsoft_us`).
- **RF-04.3**: Se conserva el nombre original del adjunto, sanitizado (sin caracteres inválidos para filesystem, máx. 180 caracteres).
- **RF-04.4**: Colisión de nombres: si el archivo ya existe con **distinto** hash SHA-256, se guarda con sufijo `_{primeros 8 chars del sha256}` antes de la extensión. Si el hash es **idéntico**, no se duplica: se registra el adjunto apuntando a la ruta existente.
- **RF-04.5**: Cada archivo registra en BD: nombre original, nombre final en disco, ruta relativa, tipo (`JSON`/`PDF`), MIME, tamaño en bytes y SHA-256.
- **RF-04.6**: La escritura es atómica: se escribe a archivo temporal (`.tmp`) y se renombra al finalizar, evitando archivos parciales ante caídas.

### RF-05 — Consulta y auditoría
- **RF-05.1**: Endpoint de listado de correos procesados con filtros combinables: cuenta, rango de fechas de recepción, remitente (búsqueda parcial), estado, con/sin adjuntos. Paginado (cursor o offset, 50 por página por defecto).
- **RF-05.2**: Endpoint de detalle de un correo con sus adjuntos y rutas.
- **RF-05.3**: Endpoint de descarga de un adjunto individual por ID (stream desde disco, `Content-Disposition` con nombre original).
- **RF-05.4**: Endpoint de estadísticas: correos y archivos por cuenta/mes, total de bytes almacenados, últimos errores.
- **RF-05.5**: Endpoint de listado de `SyncLog` por cuenta con paginación.

### RF-06 — Seguridad y acceso
- **RF-06.1**: Toda la API requiere autenticación (API Key en header `X-Api-Key` para el MVP; JWT si se agrega panel web en fase 2).
- **RF-06.2**: Las rutas de descarga validan que el path resuelto esté dentro de `STORAGE_ROOT` (protección path traversal).
- **RF-06.3**: Los logs de aplicación nunca incluyen contraseñas ni contenido de correos, solo metadatos.

## 2. Requisitos no funcionales

| ID | Categoría | Requisito |
|---|---|---|
| RNF-01 | Rendimiento | Procesar ≥ 100 correos/minuto por worker; adjuntos hasta 25 MB |
| RNF-02 | Disponibilidad | El scheduler se recupera automáticamente al reiniciar el contenedor; jobs pendientes persisten en Redis |
| RNF-03 | Escalabilidad | Concurrencia configurable de workers; hasta 10 cuentas sin cambio de arquitectura |
| RNF-04 | Integridad | 0 duplicados garantizados por constraint único `(accountId, messageId)` en BD + verificación de hash en disco |
| RNF-05 | Seguridad | AES-256-GCM para credenciales; TLS obligatorio en conexiones IMAP; secrets vía variables de entorno |
| RNF-06 | Observabilidad | Logs estructurados (pino, JSON) con `accountId` y `syncId` como contexto; niveles configurables |
| RNF-07 | Mantenibilidad | TypeScript strict, ESLint + Prettier, cobertura de pruebas ≥ 70% en servicios de dominio |
| RNF-08 | Portabilidad | Docker Compose con servicios: api, worker, postgres, redis; volumen persistente para storage |
| RNF-09 | Zona horaria | Fechas en BD en UTC; carpeta mensual calculada en `America/El_Salvador` |
| RNF-10 | Respaldo | El directorio storage y la BD deben ser respaldables con rsync/pg_dump sin detener el servicio |

## 3. Casos de uso principales

### CU-01: Alta de cuenta de correo
1. Admin envía `POST /accounts` con datos IMAP.
2. Sistema prueba conexión IMAP → si falla, retorna 422 con causa.
3. Sistema cifra contraseña, persiste cuenta, crea carpeta base en storage.
4. Sistema encola primera sincronización.

### CU-02: Sincronización periódica (flujo feliz)
1. Scheduler dispara job para la cuenta X.
2. Worker adquiere lock Redis `sync:{accountId}`.
3. Conecta IMAP, busca `UID > lastUid`.
4. Por cada mensaje: verifica idempotencia → parsea → filtra adjuntos → escribe archivos (tmp + rename) → registra en BD (transacción) → actualiza `lastUid`.
5. Cierra conexión, escribe `SyncLog`, libera lock.

### CU-03: Consulta contable mensual
1. Contador consulta `GET /emails?account=X&from=2026-07-01&to=2026-07-31&status=PROCESADO`.
2. Sistema retorna listado con remitentes, fechas y adjuntos.
3. Contador descarga adjuntos o accede directamente a `storage/compras_ltsoft_us/2026-07/`.

### CU-04: Recuperación ante fallo
1. Proveedor IMAP rechaza conexión.
2. Job reintenta 3 veces con backoff.
3. Agotado: `SyncLog = ERROR`, `account.lastError` actualizado.
4. Siguiente ciclo del scheduler reintenta normalmente; al recuperarse, la sincronización incremental cubre todo lo pendiente sin pérdida (el `lastUid` no avanzó).

## 4. Matriz de estados

**Correo (`ProcessedEmail.status`)**: `PROCESADO` | `SIN_ADJUNTOS` | `ERROR`

**Sincronización (`SyncLog.status`)**: `EJECUTANDO` | `COMPLETADO` | `COMPLETADO_CON_ERRORES` | `ERROR`

**Cuenta (`EmailAccount.status`)**: `ACTIVA` | `INACTIVA` | `ERROR_AUTH` (auto-asignado tras 3 sincronizaciones consecutivas con fallo de autenticación; requiere re-ingreso de credenciales)
