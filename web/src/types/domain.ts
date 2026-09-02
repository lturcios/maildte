/**
 * Tipos del dominio de negocio (cuentas IMAP, correos, adjuntos, logs de
 * sincronización, estadísticas), calcados del contrato real del backend.
 * Fuentes:
 * - src/accounts/accounts.controller.ts, accounts.service.ts, dto/*.ts
 * - src/emails/emails.controller.ts, attachments.controller.ts,
 *   sync-logs.controller.ts, emails.service.ts, sync-logs.service.ts, dto/*.ts
 * - src/stats/stats.controller.ts, stats.service.ts
 * - prisma/schema.prisma en la raíz del repo
 *
 * Nota: `uidValidity` es `BigInt?` en Prisma. El backend registra
 * `BigInt.prototype.toJSON` (src/common/bigint-json.ts) para serializarlo
 * como string en las respuestas JSON — por eso acá es `string | null`.
 */

import type { UserRole } from '@/types/auth';

export type AccountStatus = 'ACTIVA' | 'INACTIVA' | 'ERROR_AUTH';
export type EmailStatus = 'PROCESADO' | 'SIN_ADJUNTOS' | 'ERROR';
export type SyncStatus = 'EJECUTANDO' | 'COMPLETADO' | 'COMPLETADO_CON_ERRORES' | 'ERROR';
export type AttachmentFileType = 'JSON' | 'PDF';

/**
 * Catálogo maestro de servicios de correo (Addendum 09).
 * Fuentes: src/mail-providers/mail-providers.service.ts (PROVIDER_SELECT) y
 * src/accounts/accounts.service.ts (SAFE_PROVIDER_SELECT).
 */
export type DomainMatchKind = 'DOMAIN' | 'MX_SUFFIX';

export interface MailProviderDomain {
  id: string;
  domain: string;
  kind: DomainMatchKind;
}

/** Forma del perfil tal como viene anidado dentro de una cuenta (sin dominios). */
export interface AccountMailProvider {
  id: string;
  key: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  defaultMailbox: string;
  /** Dominio obvio: advertir si el usuario cambia el perfil detectado. */
  strict: boolean;
  /** Requisito de autenticación en lenguaje del usuario (contraseña de aplicación, etc.). */
  notes: string | null;
  helpUrl: string | null;
  active: boolean;
}

/** Forma completa del perfil en el catálogo (GET /mail-providers). */
export interface MailProvider extends AccountMailProvider {
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  domains: MailProviderDomain[];
}

/**
 * Respuesta de GET /mail-providers/resolve?email=. `source` indica cómo se
 * llegó al perfil: por el dominio del correo, por el registro MX del dominio
 * propio, o null si no se pudo inferir (el usuario elige a mano).
 */
export interface ResolveProviderResult {
  provider: MailProvider | null;
  source: 'DOMAIN' | 'MX' | null;
}

/**
 * Administración del catálogo, exclusiva de SUPERADMIN.
 * Fuente: src/mail-providers/admin-mail-providers.controller.ts y dto/*.ts.
 */
export interface MailProviderDomainInput {
  domain: string;
  kind: DomainMatchKind;
}

/** Body de POST /admin/mail-providers. `key` es inmutable tras la creación. */
export interface CreateMailProviderInput {
  key: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  defaultMailbox?: string;
  strict?: boolean;
  notes?: string;
  helpUrl?: string;
  active?: boolean;
  sortOrder?: number;
  domains?: MailProviderDomainInput[];
}

/**
 * Body de PATCH /admin/mail-providers/:id. Sin `key`: es inmutable.
 * `domains`, si viene, REEMPLAZA la lista completa.
 */
export interface UpdateMailProviderInput {
  name?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  defaultMailbox?: string;
  strict?: boolean;
  notes?: string;
  helpUrl?: string;
  active?: boolean;
  sortOrder?: number;
  domains?: MailProviderDomainInput[];
  /**
   * Obligatorio para cambiar host/puerto/TLS de un perfil en uso: como el
   * vínculo es una referencia viva, el cambio se aplica en caliente a todos los
   * tenants en su siguiente sincronización (ADR-09.1).
   */
  confirmAffectedAccounts?: number;
}

/** Respuesta de GET /admin/mail-providers/:id/usage. */
export interface MailProviderUsage {
  /** Todas las cuentas vinculadas, incluidas las eliminadas por soft delete. */
  accounts: number;
  activeAccounts: number;
  /** Cuentas eliminadas que conservan el vínculo: también impiden el borrado. */
  deletedAccounts: number;
  tenants: number;
}

/** Respuesta de GET /admin/mail-providers/usage: uso de todos los perfiles. */
export type MailProviderUsageMap = Record<string, MailProviderUsage>;

/** Respuesta de POST /admin/mail-providers/:id/probe. */
export type MailProviderProbeResult =
  | { reachable: true; latencyMs: number; greeting: string }
  | { reachable: false; latencyMs: number; reason: string };

/** Nunca incluye `imapPassEnc`: el backend proyecta explícitamente esta forma. */
export interface SafeAccount {
  id: string;
  tenantId: string;
  alias: string;
  email: string;
  folderName: string;
  /**
   * Vínculo con el catálogo (Addendum 09). Con perfil, el endpoint vigente es
   * el de `provider` y las tres columnas imap* de abajo son solo el último
   * valor escrito. Con `providerId: null`, la cuenta es de servidor
   * personalizado y esas columnas SÍ son la configuración vigente.
   */
  providerId: string | null;
  provider: AccountMailProvider | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  mailbox: string;
  syncInterval: number;
  syncFromDate: string;
  lastUid: number;
  uidValidity: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  status: AccountStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Body de POST /accounts. `syncFromDate` es opcional: si se omite, el
 * backend lo fija a `now()` en la creación (RF-02.2).
 */
export interface CreateAccountInput {
  alias: string;
  email: string;
  /**
   * Con `providerId`, el backend toma host/puerto/TLS del catálogo y los tres
   * campos imap* de abajo se ignoran (por eso son opcionales). Sin él, la
   * cuenta es de servidor personalizado y los tres pasan a ser obligatorios.
   */
  providerId?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser: string;
  imapPassword: string;
  mailbox?: string;
  syncInterval?: number;
  syncFromDate?: string;
}

/**
 * Body de POST /accounts/:id/resync. Cambia el punto de partida de la cuenta
 * y fuerza que el próximo sync recorra el buzón de nuevo desde esa fecha
 * (ver AccountsService.resyncFrom) — a diferencia de `syncFromDate` en
 * CreateAccountInput, que solo aplica en la primera sincronización, esto sí
 * tiene efecto sobre una cuenta que ya sincronizó antes.
 */
export interface ResyncAccountInput {
  syncFromDate: string;
}

/** Body de PATCH /accounts/:id. `status` solo admite ACTIVA/INACTIVA (ERROR_AUTH es auto-asignado). */
export interface UpdateAccountInput {
  alias?: string;
  email?: string;
  /**
   * Ausente no toca el vínculo; un id lo cambia; `null` desvincula y la cuenta
   * pasa a servidor personalizado (ver UpdateAccountDto del backend).
   */
  providerId?: string | null;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser?: string;
  imapPassword?: string;
  mailbox?: string;
  syncInterval?: number;
  status?: 'ACTIVA' | 'INACTIVA';
}

export interface TestConnectionResult {
  ok: true;
  latencyMs: number;
}

export interface TriggerSyncResult {
  enqueued: true;
}

export interface Attachment {
  id: string;
  tenantId: string;
  emailId: string;
  originalName: string;
  storedName: string;
  relativePath: string;
  fileType: AttachmentFileType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface ProcessedEmail {
  id: string;
  tenantId: string;
  accountId: string;
  messageId: string;
  uid: number;
  subject: string;
  senderName: string;
  senderEmail: string;
  recipients: string[];
  receivedAt: string;
  processedAt: string;
  monthFolder: string;
  attachmentCount: number;
  status: EmailStatus;
  errorDetail: string | null;
}

export type ProcessedEmailWithAttachments = ProcessedEmail & { attachments: Attachment[] };

export interface SyncLog {
  id: string;
  tenantId: string;
  accountId: string;
  startedAt: string;
  finishedAt: string | null;
  emailsFound: number;
  emailsProcessed: number;
  emailsSkipped: number;
  filesDownloaded: number;
  status: SyncStatus;
  errorDetail: string | null;
  /** Persistido como string libre en BD; en la práctica siempre 'scheduler' | 'manual'. */
  trigger: string;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

/**
 * Respuesta de GET /export/manifest. A diferencia de ListEmailsQuery (que
 * filtra por status/sender/hasAttachments sobre ProcessedEmail), el export
 * solo entiende accountId + since/until (createdAt del Attachment, no
 * receivedAt del correo) o month — ver ExportManifestDto/ExportArchiveDto.
 */
export interface ExportManifestEntry {
  attachmentId: string;
  relativePath: string;
  fileType: AttachmentFileType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  receivedAt: string;
  senderEmail: string;
  missing: boolean;
}

export interface ExportManifestPage {
  data: ExportManifestEntry[];
  meta: {
    nextCursor: string | null;
    maxCreatedAt: string | null;
    totalFiles: number;
    totalBytes: number;
    missingFiles: number;
  };
}

export interface AccountSummary {
  accountId: string;
  emailsByStatus: Partial<Record<EmailStatus, number>>;
  totalEmails: number;
  filesCount: number;
  totalBytes: number;
}

export interface AccountMonthSummary {
  accountId: string;
  monthFolder: string;
  emailsCount: number;
  filesCount: number;
  totalBytes: number;
}

export interface StatsSummary {
  byAccount: AccountSummary[];
  byAccountMonth: AccountMonthSummary[];
  recentErrors: SyncLog[];
}

export interface ListEmailsQuery {
  accountId?: string;
  from?: string;
  to?: string;
  sender?: string;
  status?: EmailStatus;
  hasAttachments?: boolean;
  page?: number;
  limit?: number;
}

export interface ListSyncLogsQuery {
  accountId?: string;
  status?: SyncStatus;
  page?: number;
  limit?: number;
}

/**
 * Gestión de tenants (multi-tenancy), exclusiva de SUPERADMIN.
 * Fuentes: src/admin/admin.controller.ts, admin.service.ts, dto/*.ts.
 *
 * Nota: `maxStorageBytes` es `BigInt` en Prisma (mismo caso que
 * `uidValidity` en EmailAccount, arriba). El backend lo serializa como
 * string vía `BigInt.prototype.toJSON` (src/common/bigint-json.ts) — por
 * eso acá es `string`, no `number`.
 */
export type AdminTenantStatus = 'ACTIVO' | 'SUSPENDIDO';

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  status: AdminTenantStatus;
  maxAccounts: number;
  maxStorageBytes: string;
  createdAt: string;
  updatedAt: string;
}

/** Body de POST /admin/tenants. `slug` es inmutable tras la creación. */
export interface CreateTenantInput {
  name: string;
  slug: string;
  maxAccounts?: number;
  maxStorageBytes?: number;
}

/** Body de PATCH /admin/tenants/:id. Sin `slug`: es inmutable. */
export interface UpdateTenantInput {
  name?: string;
  maxAccounts?: number;
  maxStorageBytes?: number;
}

/** Respuesta de GET /admin/tenants/:id/usage. */
export interface TenantUsage {
  accounts: number;
  emailsByStatus: { status: string; count: number }[];
  totalFiles: number;
  totalBytes: number;
  recentErrors: {
    id: string;
    accountId: string;
    startedAt: string;
    errorDetail: string | null;
  }[];
}

/** Body de POST /admin/tenants/:id/users. Da de alta un ADMIN del tenant (acción repetible). */
export interface CreateTenantAdminInput {
  email: string;
  name: string;
  password: string;
}

/** Respuesta de POST /admin/tenants/:id/users (SAFE_USER_SELECT del backend). */
export interface TenantAdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}
