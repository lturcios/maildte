---
name: api-conventions
description: Convenciones de la API REST de MailDTE con NestJS. Usar siempre que se creen o modifiquen controllers, DTOs, guards, filtros de excepciones, endpoints de descarga por stream o respuestas HTTP. Cubre formato de respuesta y error, validación con class-validator, autenticación por API key, descarga segura de archivos y throttling.
---

# Skill: api-conventions

## Cuándo aplica
Todo código en `*.controller.ts`, `dto/`, `common/guards/`, `common/filters/`.

## Contratos de respuesta (inmutables)

```jsonc
// Listados
{ "data": [ ... ], "meta": { "page": 1, "limit": 50, "total": 1240 } }
// Detalle / creación
{ "data": { ... } }
// Error (filtro global — único formato de error de toda la API)
{ "statusCode": 422, "error": "IMAP_AUTH_FAILED",
  "message": "Autenticación rechazada por imap.gmail.com" }
```

- `error`: código estable en MAYÚSCULAS_CON_GUIONES (contrato para clientes; no cambiar textos de `message` como mecanismo de detección).
- `message`: en español, orientado al usuario, sin stack traces ni rutas del servidor ni credenciales.
- Prefijo global `/api/v1`. Versionado por prefijo; cambios incompatibles → `/api/v2`.

## Controllers
1. Delgados: validar con DTO → delegar al service → retornar. Cero lógica de negocio, cero Prisma.
2. Códigos: 201 en creación, 200 en resto, 204 en delete sin body. Errores de dominio → excepciones NestJS (`UnprocessableEntityException` con `{ error, message }`).
3. Identificadores en rutas: UUID validado con `ParseUUIDPipe`.

## DTOs (class-validator)

```typescript
export class ListEmailsDto {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MaxLength(120) sender?: string;
  @IsOptional() @IsEnum(EmailStatus) status?: EmailStatus;
  @IsOptional() @Transform(({ value }) => value === 'true')
  @IsBoolean() hasAttachments?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
}
```

`ValidationPipe` global: `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`.

## Autenticación

```typescript
// ApiKeyGuard — comparación en tiempo constante, longitud incluida
const provided = Buffer.from(req.headers['x-api-key'] ?? '');
const expected = Buffer.from(this.config.apiKey);
const ok = provided.length === expected.length
  && crypto.timingSafeEqual(provided, expected);
```

Guard global vía `APP_GUARD`; `/health` marcado `@Public()` (decorator + Reflector).

## Descarga de archivos (patrón obligatorio)

```typescript
@Get(':id/download')
async download(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
  const att = await this.emails.getAttachment(id);           // 404 si no existe en BD
  const abs = this.storage.resolveSafe(att.relativePath);     // valida dentro de STORAGE_ROOT → 400
  if (!existsSync(abs)) throw new GoneException({            // BD sí, disco no → 410
    error: 'FILE_MISSING', message: 'El archivo ya no está disponible en el almacenamiento' });
  res.setHeader('Content-Type', att.mimeType);
  res.setHeader('Content-Length', att.sizeBytes);
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
  createReadStream(abs).pipe(res);
}
```

- Siempre stream, nunca `readFile` a memoria.
- `filename*=UTF-8''` para nombres con tildes/ñ (comunes en DTE).
- La API expone solo `relativePath`; jamás rutas absolutas del servidor.

## Throttling y límites
- `@nestjs/throttler` global: 100 req/min. La descarga de adjuntos puede subirse a 300 req/min con `@Throttle` propio si el consumo contable lo requiere.
- Body máximo de la API: 1 MB (no recibe archivos; los archivos entran por IMAP).

## Idioma y logging
- Identificadores/código en inglés; `message` de errores y textos de negocio en español.
- Logs de requests con pino-http: método, ruta, status, duración, sin headers de auth. Prohibido `console.log`.
