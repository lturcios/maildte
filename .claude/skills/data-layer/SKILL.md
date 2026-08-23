---
name: data-layer
description: Convenciones de Prisma y PostgreSQL en MailDTE. Usar siempre que se modifique schema.prisma, se creen migraciones, se escriban consultas, transacciones, agregaciones groupBy o se manejen fechas en base de datos. Cubre idempotencia por constraint único, transacción correo+adjuntos con rollback en disco, UTC obligatorio, soft delete y cifrado de credenciales.
---

# Skill: data-layer

## Cuándo aplica
Cualquier cambio en `prisma/`, todo código que use `PrismaService`, y el manejo de credenciales cifradas.

## Reglas duras
1. Cambios de esquema SOLO con `pnpm prisma migrate dev --name descripcion_corta`. Prohibido `db push` fuera de experimentos locales descartables.
2. El constraint `@@unique([accountId, messageId])` de `ProcessedEmail` **jamás se elimina ni se relaja**: es la garantía física de idempotencia.
3. Fechas en BD siempre UTC (`DateTime` de Prisma ya lo es). Prohibida cualquier conversión de TZ en la capa de datos (eso vive en `atomic-storage`).
4. Prisma solo en services. Nunca en controllers ni en DTOs.
5. `imapPassEnc` nunca aparece en un `select`/`include` que alimente una respuesta HTTP. Patrón: select explícito de campos seguros en `AccountsService`.

## Transacción correo + adjuntos (patrón central)

```typescript
// 1) Escribir archivos PRIMERO (fuera de la transacción — el FS no participa en ella)
const saved: SavedFile[] = [];
for (const att of validAttachments) {
  saved.push(await this.storage.saveAttachment({ ... }));
}

// 2) Transacción BD
try {
  await this.prisma.$transaction(async (tx) => {
    const email = await tx.processedEmail.create({
      data: {
        accountId, messageId, uid, subject, senderName, senderEmail,
        recipients, receivedAt, monthFolder,
        attachmentCount: saved.length,
        status: 'PROCESADO',
        attachments: {
          create: saved.map(s => ({
            originalName: s.originalName, storedName: s.storedName,
            relativePath: s.relativePath, fileType: s.fileType,
            mimeType: s.mimeType, sizeBytes: s.sizeBytes, sha256: s.sha256,
          })),
        },
      },
    });
    await tx.emailAccount.update({
      where: { id: accountId },
      data: { lastUid: { set: Math.max(lastUid, uid) } },
    });
    return email;
  });
} catch (err) {
  // 3) Rollback en disco: solo archivos NO reutilizados
  await this.storage.deleteFiles(saved.filter(s => !s.reused).map(s => s.relativePath));
  if (isPrismaUniqueViolation(err, 'accountId_messageId')) {
    // carrera perdida contra otro proceso: tratar como duplicado, no como error
    counters.emailsSkipped++;
    return;
  }
  await this.registerEmailError(accountId, messageId, uid, err); // ProcessedEmail ERROR
}
```

Claves del patrón:
- La verificación previa de idempotencia (`findUnique`) es una optimización; la **garantía** es el constraint. La violación P2002 se maneja como duplicado, no como fallo.
- `lastUid` se actualiza dentro de la misma transacción del correo (o inmediatamente tras un skip), nunca al final del lote.

```typescript
export function isPrismaUniqueViolation(err: unknown, target?: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === 'P2002'
    && (!target || String(err.meta?.target).includes(target));
}
```

## Soft delete
- Borrar cuenta = `update { deletedAt: new Date(), status: 'INACTIVA' }`.
- Todo listado/búsqueda de cuentas filtra `deletedAt: null` (helper `whereActive()` en el service; no repetir el literal).
- `ProcessedEmail`, `Attachment` y `SyncLog` de cuentas borradas se conservan siempre (requisito de auditoría fiscal).

## Paginación estándar

```typescript
const [data, total] = await this.prisma.$transaction([
  this.prisma.processedEmail.findMany({ where, skip: (page-1)*limit, take: limit,
    orderBy: { receivedAt: 'desc' }, include: { attachments: true } }),
  this.prisma.processedEmail.count({ where }),
]);
return { data, meta: { page, limit, total } };
```

`limit` por defecto 50, máximo 200 (clamp en el DTO).

## Agregaciones para stats

```typescript
// bytes y archivos por cuenta+mes: groupBy sobre Attachment vía relación
// correos por cuenta+mes+estado:
await this.prisma.processedEmail.groupBy({
  by: ['accountId', 'monthFolder', 'status'],
  _count: { _all: true },
  where: { receivedAt: { gte: twelveMonthsAgo } },
});
```

Nunca traer filas completas para sumar en JS: agregación siempre en PostgreSQL (`groupBy`, `aggregate`).

## Credenciales
- Cifrar en el service justo antes del `create/update`; descifrar justo antes de conectar IMAP. La credencial en claro nunca se asigna a una propiedad del objeto cuenta que circule por la app.
- Formato en BD: `base64(iv):base64(authTag):base64(cipher)` (ver `AesService`).
- Prohibido incluir `imapPassEnc` o credenciales en logs, mensajes de error o payloads de jobs BullMQ (el job lleva solo `accountId`; el worker relee la cuenta de BD).
