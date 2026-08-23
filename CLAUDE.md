# CLAUDE.md — MailDTE Collector
Reglas para Claude Code durante la implementación. **Este archivo es ley del proyecto.**

## Contexto
Servicio NestJS que sincroniza múltiples cuentas IMAP, descarga adjuntos JSON/PDF (DTE de El Salvador) y los archiva en `STORAGE_ROOT/{cuenta}/{YYYY-MM}/{json|pdf}/` con registro auditable en PostgreSQL. Documentos de referencia: `01-PRD`, `02-SRS`, `03-ARQUITECTURA-TECNICA` (la arquitectura manda ante cualquier duda).

## Reglas no negociables

### Stack y tooling
1. **pnpm exclusivamente.** Jamás npm ni yarn. Si un comando falla, no cambiar de gestor: diagnosticar.
2. **TypeScript strict** (`"strict": true`). Prohibido `any`; usar `unknown` + narrowing. Prohibido `@ts-ignore` (excepción: `@ts-expect-error` con comentario justificando).
3. NestJS 10, Prisma, BullMQ, `imapflow`, `mailparser`, `pino`. No introducir librerías nuevas sin justificar en un comentario del PR/commit.
4. Node 20 LTS. ESM no: el proyecto usa CommonJS estándar de NestJS.

### Base de datos
5. Todo cambio de esquema vía `prisma migrate dev` con nombre descriptivo. Nunca `db push` fuera de experimentos locales.
6. El constraint `@@unique([accountId, messageId])` **nunca se elimina ni se relaja**. Es la garantía de idempotencia.
7. Fechas en BD siempre UTC. La única conversión a `America/El_Salvador` vive en `StorageService.resolveMonthFolder()` — un solo lugar.
8. Escrituras correo+adjuntos siempre en `prisma.$transaction`. Si la transacción falla, borrar los archivos escritos de ese correo antes de continuar.

### IMAP y sincronización
9. Nunca marcar correos como leídos ni modificar flags en el buzón: conexión de **solo lectura** (`mailboxOpen(mailbox, { readOnly: true })`).
10. Nunca borrar correos del servidor. Este sistema solo lee.
11. `lastUid` se actualiza tras cada correo procesado con éxito, no al final del lote.
12. Verificar `uidValidity` en cada apertura de buzón; si cambió, resetear `lastUid = 0` y loggear WARN.
13. Un fallo en un correo individual no aborta la sincronización: registrar `ERROR` y continuar.
14. Lock Redis por cuenta (`SET NX` + TTL) antes de sincronizar; liberar en `finally`.

### Archivos
15. Escritura atómica obligatoria: `.tmp` → `fsync` → `rename`. Nunca `writeFile` directo al destino final.
16. Sanitizar todo nombre de archivo con `sanitizeFilename()` de `common/utils`. Nunca usar el nombre del adjunto crudo en una ruta.
17. Calcular SHA-256 siempre; resolver colisiones según regla RF-04.4. Nunca sobrescribir un archivo existente.
18. Toda ruta se construye con `path.join(STORAGE_ROOT, ...)` y se valida con `resolvedPath.startsWith(STORAGE_ROOT)` antes de leer o escribir.

### Seguridad
19. Contraseñas IMAP: cifrar con `AesService` (AES-256-GCM) antes de persistir. Prohibido loggearlas, retornarlas en la API o incluirlas en mensajes de error.
20. Prohibido `rejectUnauthorized: false` en cualquier conexión TLS.
21. Secrets solo por variables de entorno validadas al bootstrap (Joi). Si falta una variable, el proceso no arranca.
22. Comparación de API Key con `timingSafeEqual`.

### Código
23. Idioma: código e identificadores en inglés; mensajes de error de la API, logs de negocio y documentación en español.
24. Controllers delgados: validación en DTOs, lógica en services. Nada de Prisma en controllers.
25. Logs con pino estructurado incluyendo `accountId` y `syncId` en el contexto del sync. Prohibido `console.log`.
26. Tests: cada service de dominio (`sync`, `storage`, `accounts`) con unit tests (mock de Prisma/ImapFlow). Mínimo: idempotencia, colisión de nombres, sanitización, cálculo de monthFolder en bordes de mes/TZ.

## Anti-patrones (prohibido)

- ❌ Descargar el buzón completo en cada sync (siempre incremental por UID).
- ❌ Cargar todos los adjuntos de un lote en memoria: procesar mensaje por mensaje, streams para archivos > 5 MB.
- ❌ Filtrar adjuntos solo por MIME o solo por extensión: son criterios OR (RF-03.2), muchos emisores de DTE envían `application/octet-stream`.
- ❌ Usar la fecha de procesamiento para la carpeta mensual (es la fecha de **recepción**, ADR-5).
- ❌ `setInterval`/`@Cron` para la sincronización: el scheduling vive en BullMQ (jobs repetibles), que sobrevive reinicios.
- ❌ Capturar excepciones y silenciarlas (`catch {}`). Todo catch loggea y decide: reintentar, registrar ERROR o propagar.
- ❌ Migrar datos o borrar carpetas de storage desde código de aplicación sin flag explícito de mantenimiento.
- ❌ Devolver rutas absolutas del servidor en la API (solo `relativePath`).

## Comandos del proyecto

```bash
pnpm install
pnpm prisma migrate dev
pnpm start:dev          # API con watch
pnpm start:worker:dev   # Worker con watch
pnpm test
pnpm lint
pnpm build
```

## Definición de terminado (DoD) por tarea
1. Compila con `pnpm build` sin warnings de TS.
2. `pnpm lint` limpio.
3. Tests de la funcionalidad pasan.
4. Sin `any`, sin `console.log`, sin secrets hardcodeados.
5. Reglas de este archivo verificadas contra el diff.
