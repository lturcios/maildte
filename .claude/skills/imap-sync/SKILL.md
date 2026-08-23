---
name: imap-sync
description: Patrones obligatorios para conexión IMAP con imapflow y parseo con mailparser en MailDTE. Usar siempre que se escriba o modifique código que conecte a buzones de correo, haga fetch de mensajes, parsee MIME o filtre adjuntos. Cubre conexión readOnly, fetch incremental por UID, manejo de UIDVALIDITY, taxonomía de errores IMAP y criterio de filtrado de adjuntos JSON/PDF.
---

# Skill: imap-sync

## Cuándo aplica
Cualquier código en `sync/imap/` o `sync/sync.service.ts` que toque imapflow o mailparser.

## Reglas duras
1. Conexión **siempre de solo lectura**: `client.mailboxOpen(mailbox, { readOnly: true })`. Jamás modificar flags (`\Seen`), mover ni borrar mensajes.
2. TLS obligatorio. Prohibido `tls: { rejectUnauthorized: false }`.
3. Fetch **incremental por UID**, nunca el buzón completo.
4. Procesar mensaje por mensaje (iterador async). Nunca acumular sources del lote en memoria.
5. Timeouts explícitos: `greetingTimeout: 15000, socketTimeout: 60000`.
6. `logger: false` en ImapFlow (el logging lo hace pino de la app, con contexto propio).

## Patrón de conexión (ImapClientFactory)

```typescript
const client = new ImapFlow({
  host: account.imapHost,
  port: account.imapPort,
  secure: account.imapSecure,          // true → TLS implícito (993)
  auth: { user: account.imapUser, pass: aes.decrypt(account.imapPassEnc) },
  logger: false,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
});
```

## Patrón de fetch incremental

```typescript
const mailbox = await client.mailboxOpen(account.mailbox, { readOnly: true });

// UIDVALIDITY: si cambia, los UID viejos no valen
if (account.uidValidity && mailbox.uidValidity !== account.uidValidity) {
  logger.warn({ accountId }, 'UIDVALIDITY cambió: reset de lastUid');
  await accounts.resetUidTracking(account.id, mailbox.uidValidity);
  account.lastUid = 0;
}

for await (const msg of client.fetch(
  `${account.lastUid + 1}:*`,
  { uid: true, envelope: true, source: true },
  { uid: true },                        // ← el rango es de UIDs, no de secuencia
)) {
  // Guard: el rango "n:*" devuelve el último mensaje aunque n > máximo
  if (msg.uid <= account.lastUid) continue;
  await processMessage(msg);            // secuencial, uno a la vez
}
```

**Trampa conocida**: en IMAP, `{lastUid+1}:*` con buzón sin mensajes nuevos retorna el último mensaje existente. El guard `msg.uid <= account.lastUid` es obligatorio.

## Parseo (message-parser.ts)

```typescript
import { simpleParser } from 'mailparser';

const parsed = await simpleParser(msg.source);
return {
  messageId: parsed.messageId ?? `synthetic-${account.id}-${msg.uid}`, // fallback si falta header
  subject: parsed.subject ?? '',
  senderName: parsed.from?.value[0]?.name ?? '',
  senderEmail: (parsed.from?.value[0]?.address ?? '').toLowerCase(),
  recipients: (parsed.to?.value ?? []).map(a => a.address ?? '').filter(Boolean),
  receivedAt: parsed.date ?? new Date(),   // header Date; fallback: now
  attachments: parsed.attachments,          // Buffer en attachment.content
};
```

- `messageId` puede venir ausente o duplicado entre remitentes mal configurados: el fallback sintético con `accountId + uid` mantiene la idempotencia.
- `receivedAt` se guarda tal cual (UTC). La conversión a TZ local es responsabilidad exclusiva de la skill `atomic-storage`.

## Filtrado de adjuntos (criterio OR — no negociable)

```typescript
const isTarget = (a: Attachment) =>
  /\.(json|pdf)$/i.test(a.filename ?? '') ||
  ['application/json', 'application/pdf'].includes(a.contentType);

const type = (a: Attachment): 'JSON' | 'PDF' =>
  /\.json$/i.test(a.filename ?? '') || a.contentType === 'application/json'
    ? 'JSON' : 'PDF';
```

Razón: muchos emisores de DTE en El Salvador envían los adjuntos como `application/octet-stream` con nombre correcto, y otros con MIME correcto pero nombres raros. Filtrar por un solo criterio pierde documentos reales.

## Taxonomía de errores IMAP → códigos de la API

| Detección | Código | HTTP |
|---|---|---|
| `err.authenticationFailed === true` o respuesta `NO [AUTHENTICATIONFAILED]` | `IMAP_AUTH_FAILED` | 422 |
| `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT` | `IMAP_HOST_UNREACHABLE` | 422 |
| Errores TLS (`ERR_TLS_*`, `CERT_*`) | `IMAP_TLS_ERROR` | 422 |
| Cualquier otro | `IMAP_UNKNOWN` | 502 |

`IMAP_AUTH_FAILED` alimenta el contador de fallos consecutivos que lleva a `ERROR_AUTH` (ver skill `queues-worker`).

## Cierre limpio

```typescript
try { /* sync */ } finally {
  await client.logout().catch(() => client.close());
}
```
