---
name: queues-worker
description: Patrones de BullMQ, scheduler de jobs repetibles, proceso worker standalone de NestJS, locks distribuidos en Redis, reintentos con backoff y transición a ERROR_AUTH en MailDTE. Usar siempre que se escriba código de scheduling, procesamiento en cola, concurrencia, locks o manejo de reintentos y fallos de sincronización.
---

# Skill: queues-worker

## Cuándo aplica
Código en `sync/sync.scheduler.ts`, `sync/sync.processor.ts`, `src/worker.ts` y cualquier interacción con BullMQ o locks Redis.

## Arquitectura de procesos
- **API** (`main.ts`): registra jobs repetibles y encola jobs manuales. NO consume la cola.
- **Worker** (`worker.ts`): proceso NestJS standalone que SOLO consume.

```typescript
// worker.ts
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));           // pino
app.enableShutdownHooks();                 // cierre limpio: termina el job en curso
```

## Jobs repetibles (scheduler)

```typescript
// Un job repetible por cuenta ACTIVA. jobId determinístico = idempotente.
await this.syncQueue.add(
  'sync-account',
  { accountId: account.id, trigger: 'scheduler' },
  {
    repeat: { every: account.syncInterval * 1000 },
    jobId: `sync:${account.id}`,
    removeOnComplete: 100,                 // conserva historial acotado
    removeOnFail: 100,
  },
);
```

Reglas:
1. Registrar todos al bootstrap del API (`OnApplicationBootstrap`) leyendo cuentas ACTIVAS.
2. Al crear/activar cuenta → agregar job repetible. Al desactivar/borrar/ERROR_AUTH → `queue.removeRepeatable('sync-account', { every, jobId })` (se necesita el `every` original: leerlo de la cuenta antes de modificarla).
3. Al cambiar `syncInterval` → remover el repetible viejo y crear el nuevo.
4. Sync manual: `queue.add('sync-account', { accountId, trigger: 'manual' }, { attempts: 1 })` — sin repeat, sin jobId repetible.
5. Prohibido `@Cron` / `setInterval` para scheduling: no sobreviven reinicios ni escalan a múltiples instancias.

## Consumidor

```typescript
new Worker('sync', processor, {
  connection: redis,
  concurrency: 3,        // paralelo ENTRE cuentas; el lock garantiza serie DENTRO de cada cuenta
});
```

## Lock distribuido por cuenta

```typescript
const lockKey = `lock:sync:${accountId}`;
const acquired = await redis.set(lockKey, syncId, 'EX', 600, 'NX');
if (!acquired) {
  logger.debug({ accountId }, 'Sync ya en curso, se omite');
  return;                                  // salir SIN error (no es un fallo)
}
try {
  // ... sincronización completa
} finally {
  // liberar solo si el lock sigue siendo nuestro (evita borrar el de otro sync)
  const current = await redis.get(lockKey);
  if (current === syncId) await redis.del(lockKey);
}
```

TTL 600 s > duración esperada de un sync; si el proceso muere, el lock expira solo.

## Reintentos y fallos

```typescript
// Opciones del job (repetible y manual con fallo de conexión):
{ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } }  // 30s, 60s, 120s
```

Clasificación dentro del processor:
- **Error de conexión/transitorio** (host, timeout, TLS): lanzar la excepción → BullMQ reintenta.
- **Error de un correo individual**: NO lanzar; registrar `ProcessedEmail ERROR` y continuar el lote.
- **`IMAP_AUTH_FAILED`**: lanzar (reintenta por si es transitorio) Y contar.

## Transición a ERROR_AUTH

```
Campo authFailCount en memoria de BD (EmailAccount) o contador Redis
INCR auth-fail:{accountId} con TTL 24h.

Al fallar un sync completo con IMAP_AUTH_FAILED → incrementar.
Al completar un sync exitoso → resetear a 0.
Si el contador llega a 3:
  1. account.status = ERROR_AUTH, lastError con detalle
  2. removeRepeatable del job de la cuenta
  3. log ERROR (visible para el runbook)
Recuperación: PATCH con nuevas credenciales que pasen el test IMAP
  → status ACTIVA, contador a 0, re-registrar job repetible.
```

## SyncLog — ciclo de vida
1. Crear con `EJECUTANDO` + `trigger` al entrar (después de adquirir lock).
2. Actualizar contadores al final: `emailsFound, emailsProcessed, emailsSkipped, filesDownloaded`.
3. Estado final: `COMPLETADO` (sin correos ERROR) | `COMPLETADO_CON_ERRORES` (≥1 correo ERROR) | `ERROR` (sync abortado; setear también en el handler `failed` cuando se agotan reintentos).
4. `finishedAt` siempre se setea en `finally`.

## Prohibido
- Consumir la cola desde el proceso API.
- `attempts` > 3 o backoff fijo.
- Silenciar el caso "lock ocupado" como error (es flujo normal).
- Dejar jobs repetibles huérfanos de cuentas inactivas/borradas (verificar en bootstrap: remover repetibles cuya cuenta ya no está ACTIVA).
