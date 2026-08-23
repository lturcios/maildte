---
name: testing-maildte
description: Estrategia de pruebas de MailDTE. Usar siempre que se escriban unit tests o e2e tests. Cubre mocking de ImapFlow, mailparser, Prisma y Redis, la lista de casos de prueba obligatorios del proyecto (idempotencia, borde de mes con TZ, colisiones, filtrado OR, path traversal) y las convenciones de estructura de tests.
---

# Skill: testing-maildte

## Cuándo aplica
Todo archivo `*.spec.ts` (unit) y `test/*.e2e-spec.ts`.

## Convenciones
- Jest (default NestJS). Unit tests junto al archivo (`sync.service.spec.ts` al lado de `sync.service.ts`); e2e en `test/`.
- `Test.createTestingModule` con providers mockeados vía `useValue`. Nada de BD ni red real en unit tests.
- Nombres de tests en español describiendo comportamiento: `it('omite un correo cuya messageId ya fue procesada', ...)`.
- Cobertura mínima 70% en `sync/`, `storage/`, `accounts/` (verificar con `pnpm test --coverage`).

## Mocks estándar

```typescript
// Prisma — mock por delegado
export const prismaMock = {
  processedEmail: { findUnique: jest.fn(), create: jest.fn(), groupBy: jest.fn(),
                    findMany: jest.fn(), count: jest.fn() },
  emailAccount:   { update: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  syncLog:        { create: jest.fn(), update: jest.fn() },
  $transaction:   jest.fn(async (arg) =>
    typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)),
};

// Redis (ioredis)
export const redisMock = {
  set: jest.fn().mockResolvedValue('OK'),   // 'OK' = lock adquirido; null = ocupado
  get: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn(),
};

// ImapFlow — fetch como async generator
export function imapFlowMock(messages: FakeMsg[], uidValidity = 100n) {
  return {
    connect: jest.fn(), logout: jest.fn(), close: jest.fn(),
    mailboxOpen: jest.fn().mockResolvedValue({ uidValidity }),
    fetch: jest.fn(function* () { yield* messages; }),
  };
}

// Mensaje falso: construir MIME real y dejar que mailparser lo parsee de verdad
// (no mockear mailparser: es barato y prueba el parser real)
export function fakeRawEmail(opts: { messageId?: string; from: string;
  date: string; attachments: { filename: string; contentType: string; body: string }[] }): Buffer
```

Preferir `fakeRawEmail` construyendo el MIME multipart a mano (boundary fijo) sobre mockear `simpleParser`: los tests de parseo y filtrado cubren el pipeline real.

## Casos de prueba obligatorios (checklist del proyecto)

### StorageService
- [ ] Borde de mes por TZ: `receivedAt = 2026-09-01T03:00:00Z` → carpeta `2026-08`.
- [ ] Cambio de año: `2027-01-01T04:00:00Z` → `2026-12`.
- [ ] Colisión mismo nombre + mismo sha256 → `reused: true`, un solo archivo en disco.
- [ ] Colisión mismo nombre + distinto sha256 → sufijo `_{8 chars hash}`.
- [ ] `sanitizeFilename('../../etc/passwd.json')` → sin traversal, extensión preservada.
- [ ] Nombre > 180 chars → truncado conservando extensión.
- [ ] Escritura atómica: tras `saveAttachment` no quedan `.tmp`.
  (Unit tests de storage usan directorio temporal real: `fs.mkdtemp` — el FS sí se prueba de verdad.)

### SyncService
- [ ] Correo con `messageId` ya registrado → skip, `emailsSkipped` incrementa, no se escribe archivo.
- [ ] Violación P2002 en la transacción (carrera) → se trata como duplicado, no como ERROR.
- [ ] Fallo al guardar un correo (transacción lanza) → `deleteFiles` de lo escrito, correo queda ERROR, el lote continúa con el siguiente.
- [ ] Correo sin adjuntos JSON/PDF → `SIN_ADJUNTOS`, sin archivos.
- [ ] Adjunto `application/octet-stream` con nombre `factura.json` → SÍ se descarga (criterio OR).
- [ ] Adjunto `application/pdf` con nombre `documento.bin` → SÍ se descarga.
- [ ] Adjunto `imagen.png` `image/png` → se ignora.
- [ ] `uidValidity` distinto al persistido → `lastUid` reseteado a 0 antes del fetch.
- [ ] Guard de UID: mensaje con `uid <= lastUid` retornado por el rango `n:*` → se omite.
- [ ] Lock ocupado (`set` retorna null) → el job termina sin error y sin tocar IMAP.
- [ ] `lastUid` se actualiza tras cada correo, no al final (verificar orden de llamadas).

### AccountsService
- [ ] Alta con IMAP fallando auth → 422 `IMAP_AUTH_FAILED`, nada persistido.
- [ ] `folderName`: `compras@ltsoft.us` → `compras_ltsoft_us`; `facturación.dte@empresa.com.sv` → normalizado solo `[a-z0-9_-]`.
- [ ] Ninguna respuesta serializada contiene `imapPassEnc`.

### AesService
- [ ] Roundtrip cifrar/descifrar.
- [ ] AuthTag alterado → lanza (integridad GCM).
- [ ] Clave de longitud incorrecta → falla al bootstrap.

### E2E (supertest, BD de test con docker)
- [ ] `GET /emails?from=&to=&sender=` combinados → filtra correcto y `meta.total` exacto.
- [ ] `hasAttachments=true/false`.
- [ ] Descarga con adjunto cuyo `relativePath` fue manipulado a `../` en BD → 400.
- [ ] Descarga de adjunto registrado pero sin archivo en disco → 410 `FILE_MISSING`.
- [ ] Request sin `X-Api-Key` → 401.

## Prohibido
- Tests que dependan de cuentas de correo reales o red externa.
- `setTimeout` reales para esperar (usar jest fake timers si hace falta).
- Aserciones solo de "no lanza": todo test verifica estado o llamadas concretas.
