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

/** Nunca incluye `imapPassEnc`: el backend proyecta explícitamente esta forma. */
export interface SafeAccount {
  id: string;
  tenantId: string;
  alias: string;
  email: string;
  folderName: string;
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
 * Body de POST /accounts. `syncFromDate` NO es un campo aceptable acá: el
 * backend lo fija a `now()` en la creación y no se expone en
 * CreateAccountDto/UpdateAccountDto (desvío respecto al brief original).
 */
export interface CreateAccountInput {
  alias: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  mailbox?: string;
  syncInterval?: number;
}

/** Body de PATCH /accounts/:id. `status` solo admite ACTIVA/INACTIVA (ERROR_AUTH es auto-asignado). */
export interface UpdateAccountInput {
  alias?: string;
  email?: string;
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
