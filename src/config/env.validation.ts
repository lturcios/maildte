import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  // Rol de aplicación sin privilegios elevados (skill tenancy, regla 8): DATABASE_URL
  // (dueño de las tablas, corre migraciones) es superusuario y por lo tanto bypasea
  // RLS siempre, incluso con FORCE. La app en runtime conecta con este rol separado
  // para que las políticas de aislamiento tengan efecto real.
  APP_DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  STORAGE_ROOT: Joi.string().required(),
  DEFAULT_SYNC_INTERVAL: Joi.number().integer().min(30).default(300),
  TZ_FOLDER: Joi.string().default('America/El_Salvador'),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  MAX_ATTACHMENT_MB: Joi.number().integer().min(1).default(25),
  EXPORT_MAX_ZIP_FILES: Joi.number().integer().min(1).default(5000),
  // Libro de compras (Addendum 10). Tope de filas del Anexo 3: el export construye el
  // XLSX en memoria, así que el cap protege al proceso, no solo al cliente.
  PURCHASE_BOOK_EXPORT_MAX_ROWS: Joi.number().integer().min(1).default(20000),
  // Tamaño máximo de lote del backfill de parseo (POST /purchase-book/reprocess).
  PURCHASE_BOOK_REPROCESS_BATCH: Joi.number().integer().min(1).max(5000).default(1000),
  // Cap de tamaño del JSON de un DTE antes de leerlo del disco y parsearlo.
  DTE_MAX_JSON_BYTES: Joi.number().integer().min(1024).default(2097152),
  // Concurrencia del worker de la cola "dte". Comparte el pool de Prisma con el sync,
  // por eso el default es moderado.
  DTE_QUEUE_CONCURRENCY: Joi.number().integer().min(1).max(16).default(4),
  // Orígenes permitidos para el panel web (lista separada por comas). El build de
  // producción se sirve por Nginx bajo el mismo host que la API (/panel), pero el
  // dev server de Vite corre en otro puerto y necesita CORS explícito.
  CORS_ORIGIN: Joi.string().default('http://localhost:5173'),
});
