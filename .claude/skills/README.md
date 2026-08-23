# Skills del proyecto MailDTE Collector

Seis skills que encapsulan el conocimiento técnico crítico del proyecto. Claude Code las carga automáticamente cuando su descripción coincide con la tarea, y los prompts de `06-PROMPTS-CLAUDE-CODE.md` las invocan explícitamente.

## Instalación

Copiar la carpeta `skills/` a la raíz del repositorio como `.claude/skills/`:

```bash
mkdir -p .claude/skills
cp -r skills/* .claude/skills/
```

Estructura resultante:

```
maildte/
├── .claude/
│   └── skills/
│       ├── imap-sync/SKILL.md
│       ├── atomic-storage/SKILL.md
│       ├── queues-worker/SKILL.md
│       ├── data-layer/SKILL.md
│       ├── api-conventions/SKILL.md
│       └── testing-maildte/SKILL.md
├── CLAUDE.md
└── ...
```

## Mapa de responsabilidades

| Skill | Cubre | Se activa al trabajar en |
|---|---|---|
| `imap-sync` | Conexión readOnly, fetch incremental por UID, UIDVALIDITY, trampa del rango `n:*`, mailparser, filtrado OR extensión/MIME, taxonomía de errores IMAP | `sync/imap/`, `sync.service.ts` |
| `atomic-storage` | Estructura cuenta/mes, TZ El Salvador (único punto de conversión), sanitización, escritura tmp+fsync+rename, colisiones por hash, path traversal, rollback en disco | `storage/` |
| `queues-worker` | Jobs repetibles BullMQ, worker standalone, lock Redis con liberación segura, reintentos/backoff, transición ERROR_AUTH, ciclo de vida de SyncLog | `sync.scheduler.ts`, `sync.processor.ts`, `worker.ts` |
| `data-layer` | Migraciones, constraint de idempotencia, transacción correo+adjuntos con manejo de P2002, soft delete, paginación, groupBy, credenciales cifradas | `prisma/`, todos los services |
| `api-conventions` | Formato de respuesta/error, DTOs, ApiKeyGuard, descarga por stream con 410/400, throttling, idioma | `*.controller.ts`, `dto/`, `common/` |
| `testing-maildte` | Mocks de ImapFlow/Prisma/Redis, fakeRawEmail con MIME real, checklist de casos obligatorios | `*.spec.ts`, `test/` |

## Relación entre documentos

- **CLAUDE.md** → reglas transversales y anti-patrones (siempre en contexto).
- **Skills** → el "cómo" detallado con código de referencia por dominio (cargadas bajo demanda).
- **03-ARQUITECTURA** → la fuente de verdad de diseño; ante conflicto con una skill, gana la arquitectura y debe corregirse la skill.
- **06-PROMPTS** → invocan las skills relevantes por fase.

## Mantenimiento

Si durante la implementación se descubre una trampa nueva (comportamiento raro de un proveedor IMAP, edge case de mailparser), se documenta en la skill correspondiente en el mismo PR, no solo en el código.
