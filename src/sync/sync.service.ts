import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Attachment } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { EmailAccount, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../prisma/prisma-errors';
import { AesService } from '../common/crypto/aes.service';
import { AppConfigService } from '../config/app-config.service';
import { StorageService, SavedAttachment } from '../storage/storage.service';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { ImapClientFactory } from './imap/imap-client.factory';
import { ImapConnectionError, mapImapError } from './imap/imap-error';
import {
  classifyAttachment,
  isTargetAttachment,
  parseMessage,
  ParsedEmailMessage,
} from './imap/message-parser';
import { SyncScheduler } from './sync.scheduler';
import { SyncTrigger } from './queue/sync-queue.constants';
import { authFailKey } from './auth-fail-key';

const LOCK_TTL_SECONDS = 600;
const AUTH_FAIL_TTL_SECONDS = 24 * 60 * 60;
const AUTH_FAIL_THRESHOLD = 3;

interface SyncCounters {
  emailsFound: number;
  emailsProcessed: number;
  emailsSkipped: number;
  filesDownloaded: number;
}

interface MessageOutcome {
  status: 'processed' | 'skipped' | 'no-attachments' | 'error';
  filesSaved: number;
}

interface RevalidatedJob {
  tenantSlug: string;
  maxStorageBytes: bigint;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aes: AesService,
    private readonly imap: ImapClientFactory,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    private readonly scheduler: SyncScheduler,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncService.name);
  }

  async syncAccount(tenantId: string, accountId: string, trigger: SyncTrigger): Promise<void> {
    const revalidated = await this.revalidateJob(tenantId, accountId);
    if (!revalidated) return;

    const syncId = randomUUID();
    const lockKey = `lock:sync:${accountId}`;

    const acquired = await this.redis.set(lockKey, syncId, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!acquired) {
      this.logger.debug({ accountId, syncId }, 'Sync ya en curso, se omite');
      return;
    }

    try {
      await this.runSync(tenantId, accountId, revalidated, syncId, trigger);
    } finally {
      const current = await this.redis.get(lockKey);
      if (current === syncId) await this.redis.del(lockKey);
    }
  }

  /**
   * Revalida al inicio del job que la cuenta pertenece al tenant del payload y que el
   * tenant está ACTIVO (skill tenancy, regla 14). Si no, el job termina sin error, solo
   * un WARN — puede pasar en carreras normales (cuenta borrada, tenant suspendido justo
   * después de encolar el job).
   */
  private async revalidateJob(tenantId: string, accountId: string): Promise<RevalidatedJob | null> {
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: { id: accountId, tenantId }, select: { id: true } }),
    );
    if (!account) {
      this.logger.warn(
        { tenantId, accountId },
        'La cuenta no pertenece al tenant del payload (o no existe), se omite el job',
      );
      return null;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, slug: true, maxStorageBytes: true },
    });
    if (!tenant || tenant.status !== 'ACTIVO') {
      this.logger.warn({ tenantId, accountId }, 'El tenant no está ACTIVO, se omite el job');
      return null;
    }

    return { tenantSlug: tenant.slug, maxStorageBytes: tenant.maxStorageBytes };
  }

  private async runSync(
    tenantId: string,
    accountId: string,
    { tenantSlug, maxStorageBytes }: RevalidatedJob,
    syncId: string,
    trigger: SyncTrigger,
  ): Promise<void> {
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.findFirst({ where: { id: accountId, tenantId } }),
    );
    if (!account || account.deletedAt || account.status !== 'ACTIVA') {
      this.logger.warn({ accountId, syncId }, 'Cuenta no activa o inexistente, se omite sync');
      return;
    }

    const syncLog = await this.prisma.withTenant(tenantId, (tx) =>
      tx.syncLog.create({ data: { tenantId, accountId, status: 'EJECUTANDO', trigger } }),
    );
    const counters: SyncCounters = {
      emailsFound: 0,
      emailsProcessed: 0,
      emailsSkipped: 0,
      filesDownloaded: 0,
    };

    try {
      await this.storage.cleanOrphanTmp(tenantSlug, account.folderName);
      const { hadErrors } = await this.syncMailbox(
        account,
        tenantSlug,
        maxStorageBytes,
        syncId,
        counters,
      );

      await this.redis.del(authFailKey(accountId));
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.emailAccount.update({
          where: { id: accountId },
          data: { lastSyncAt: new Date(), lastError: null },
        }),
      );
      await this.finalizeSyncLog(
        tenantId,
        syncLog.id,
        counters,
        hadErrors ? 'COMPLETADO_CON_ERRORES' : 'COMPLETADO',
      );
      await this.reconcileUsage(tenantId);
      this.logger.info({ accountId, syncId, ...counters }, 'Sincronización finalizada');
    } catch (err) {
      const mapped = err instanceof ImapConnectionError ? err : mapImapError(err);
      await this.onConnectionFailure(tenantId, accountId, syncId, mapped);
      await this.finalizeSyncLog(tenantId, syncLog.id, counters, 'ERROR', mapped.message);
      await this.reconcileUsage(tenantId);
      throw mapped;
    }
  }

  private async syncMailbox(
    account: EmailAccount,
    tenantSlug: string,
    maxStorageBytes: bigint,
    syncId: string,
    counters: SyncCounters,
  ): Promise<{ hadErrors: boolean }> {
    const client = this.imap.create({
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      imapUser: account.imapUser,
      imapPassword: this.aes.decrypt(account.imapPassEnc),
    });

    try {
      await client.connect();
    } catch (err) {
      throw mapImapError(err);
    }

    try {
      const mailboxInfo = await client.mailboxOpen(account.mailbox, { readOnly: true });
      let lastUid = account.lastUid;

      if (mailboxInfo.uidValidity !== account.uidValidity) {
        if (account.uidValidity !== null) {
          this.logger.warn(
            { accountId: account.id, syncId },
            'UIDVALIDITY cambió: reset de lastUid',
          );
          lastUid = 0;
        }
        await this.prisma.withTenant(account.tenantId, (tx) =>
          tx.emailAccount.update({
            where: { id: account.id },
            data: { uidValidity: mailboxInfo.uidValidity, lastUid },
          }),
        );
      }

      // RF-02.2: en la primera sincronización (la cuenta nunca terminó un sync) se arranca
      // desde syncFromDate, no desde el UID 1 (evita traer el histórico completo del buzón).
      // Un reset de UIDVALIDITY en una cuenta ya sincronizada NO cuenta como "primera vez".
      // Se persiste de inmediato: si no llega ningún correo nuevo, el próximo sync debe
      // seguir arrancando desde aquí y NO repetir la búsqueda por syncFromDate desde UID 1.
      if (account.lastSyncAt === null) {
        lastUid = await this.resolveFirstSyncStartUid(client, account, mailboxInfo.uidNext, syncId);
        await this.prisma.withTenant(account.tenantId, (tx) =>
          tx.emailAccount.update({ where: { id: account.id }, data: { lastUid } }),
        );
      }

      let hadErrors = false;
      for await (const msg of client.fetch(
        `${lastUid + 1}:*`,
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        if (msg.uid <= lastUid) continue;

        counters.emailsFound++;
        const outcome = await this.processMessage(
          account,
          tenantSlug,
          maxStorageBytes,
          syncId,
          msg.uid,
          msg.source,
        );
        counters.filesDownloaded += outcome.filesSaved;
        if (outcome.status === 'skipped') {
          counters.emailsSkipped++;
        } else {
          counters.emailsProcessed++;
        }
        if (outcome.status === 'error') hadErrors = true;

        lastUid = Math.max(lastUid, msg.uid);
      }
      return { hadErrors };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /**
   * Busca el primer UID recibido a partir de syncFromDate y retorna el UID anterior a ese
   * (el fetch posterior usa "lastUid+1:*"). Si no hay nada desde esa fecha, retorna uidNext-1
   * para que el rango de fetch no traiga nada del histórico.
   *
   * SINCE en IMAP compara solo la fecha (sin hora), pero servidores como Gmail la tratan como
   * exclusiva del día indicado (comprobado empíricamente: "SINCE hoy" no devuelve mensajes de
   * hoy). Se resta un día de margen a syncFromDate para no perder correos por ese borde; el
   * exceso de resultados no importa porque solo se usa el UID mínimo como punto de partida y
   * la idempotencia por messageId cubre cualquier redundancia.
   */
  private async resolveFirstSyncStartUid(
    client: ImapFlow,
    account: EmailAccount,
    uidNext: number,
    syncId: string,
  ): Promise<number> {
    const searchFrom = new Date(account.syncFromDate.getTime() - 24 * 60 * 60 * 1000);
    const matches = await client.search({ since: searchFrom }, { uid: true });
    if (!matches || matches.length === 0) {
      this.logger.info(
        { accountId: account.id, syncId, syncFromDate: account.syncFromDate },
        'Primera sincronización: nada desde syncFromDate',
      );
      return Math.max(uidNext - 1, 0);
    }
    const firstUid = Math.min(...matches);
    this.logger.info(
      { accountId: account.id, syncId, syncFromDate: account.syncFromDate, firstUid },
      'Primera sincronización: arrancando desde syncFromDate',
    );
    return firstUid - 1;
  }

  private async processMessage(
    account: EmailAccount,
    tenantSlug: string,
    maxStorageBytes: bigint,
    syncId: string,
    uid: number,
    source: Buffer | undefined,
  ): Promise<MessageOutcome> {
    const logCtx = { accountId: account.id, syncId, uid };

    if (!source) {
      this.logger.warn(logCtx, 'Mensaje sin contenido (source vacío), se registra ERROR');
      await this.registerEmailError({
        tenantId: account.tenantId,
        accountId: account.id,
        messageId: `synthetic-${account.id}-${uid}`,
        uid,
        errorDetail: 'El servidor IMAP no devolvió contenido para este mensaje',
      });
      return { status: 'error', filesSaved: 0 };
    }

    const parsed = await parseMessage(source, uid, account.id);

    const existing = await this.prisma.withTenant(account.tenantId, (tx) =>
      tx.processedEmail.findUnique({
        where: { accountId_messageId: { accountId: account.id, messageId: parsed.messageId } },
        select: { id: true },
      }),
    );
    if (existing) {
      this.logger.debug(
        { ...logCtx, messageId: parsed.messageId },
        'Correo ya procesado, se omite',
      );
      // lastUid avanza igual que en un correo procesado: si no se persiste, un lote que
      // termine en duplicados nunca avanza y esos UID se re-escanean en cada sync futuro.
      await this.prisma.withTenant(account.tenantId, (tx) =>
        tx.emailAccount.update({ where: { id: account.id }, data: { lastUid: uid } }),
      );
      return { status: 'skipped', filesSaved: 0 };
    }

    const monthFolder = this.storage.resolveMonthFolder(parsed.receivedAt);
    const targets = parsed.attachments.filter(isTargetAttachment);
    const maxBytes = this.config.maxAttachmentMb * 1024 * 1024;

    const validAttachments: Attachment[] = [];
    const oversizedNames: string[] = [];
    for (const att of targets) {
      if (att.size > maxBytes) {
        oversizedNames.push(att.filename ?? '(sin nombre)');
        this.logger.warn(
          { ...logCtx, filename: att.filename, sizeBytes: att.size },
          'Adjunto excede MAX_ATTACHMENT_MB, se omite',
        );
        continue;
      }
      validAttachments.push(att);
    }
    const oversizedNote = oversizedNames.length
      ? `Adjuntos omitidos por exceder ${this.config.maxAttachmentMb}MB: ${oversizedNames.join(', ')}`
      : undefined;

    if (validAttachments.length === 0) {
      const registered = await this.persistEmail({
        account,
        parsed,
        uid,
        monthFolder,
        status: 'SIN_ADJUNTOS',
        errorDetail: oversizedNote,
      });
      return registered
        ? { status: 'no-attachments', filesSaved: 0 }
        : { status: 'skipped', filesSaved: 0 };
    }

    // Cuota de almacenamiento (skill tenancy regla 17): se estima con el tamaño ya conocido
    // por mailparser, ANTES de escribir nada a disco. Si se excede, el correo entero queda
    // ERROR con QUOTA_EXCEEDED y el sync continúa con el siguiente mensaje — no se pierde el
    // registro, solo no se descarga hasta ampliar el plan (reprocesar con lastUid en 0 luego
    // recupera lo pendiente gracias a la idempotencia por messageId).
    const estimatedBytes = validAttachments.reduce((sum, att) => sum + att.size, 0);
    const currentUsageBytes = await this.getUsageBytes(account.tenantId);
    if (currentUsageBytes + estimatedBytes > Number(maxStorageBytes)) {
      this.logger.warn(
        { ...logCtx, currentUsageBytes, estimatedBytes, maxStorageBytes: Number(maxStorageBytes) },
        'Cuota de almacenamiento del tenant excedida: correo registrado ERROR sin descargar adjuntos',
      );
      await this.registerEmailError({
        tenantId: account.tenantId,
        accountId: account.id,
        messageId: parsed.messageId,
        uid,
        subject: parsed.subject,
        senderName: parsed.senderName,
        senderEmail: parsed.senderEmail,
        recipients: parsed.recipients,
        receivedAt: parsed.receivedAt,
        monthFolder,
        errorDetail: 'QUOTA_EXCEEDED: se alcanzó el límite de almacenamiento del plan del tenant',
      });
      return { status: 'error', filesSaved: 0 };
    }

    const saved: SavedAttachment[] = [];
    for (const att of validAttachments) {
      const result = await this.storage.saveAttachment(tenantSlug, {
        content: att.content,
        account: { folderName: account.folderName },
        monthFolder,
        originalName: att.filename ?? 'archivo',
        mimeType: att.contentType,
      });
      saved.push(result);
      if (!result.reused) {
        await this.incrUsageBytes(account.tenantId, result.sizeBytes);
      }
    }

    try {
      await this.prisma.withTenant(account.tenantId, async (tx) => {
        await tx.processedEmail.create({
          data: {
            tenantId: account.tenantId,
            accountId: account.id,
            messageId: parsed.messageId,
            uid,
            subject: parsed.subject,
            senderName: parsed.senderName,
            senderEmail: parsed.senderEmail,
            recipients: parsed.recipients,
            receivedAt: parsed.receivedAt,
            monthFolder,
            attachmentCount: saved.length,
            status: 'PROCESADO',
            errorDetail: oversizedNote,
            attachments: {
              create: saved.map((s, i) => ({
                tenantId: account.tenantId,
                originalName: validAttachments[i].filename ?? 'archivo',
                storedName: s.storedName,
                relativePath: s.relativePath,
                fileType: classifyAttachment(validAttachments[i]),
                mimeType: validAttachments[i].contentType,
                sizeBytes: s.sizeBytes,
                sha256: s.sha256,
              })),
            },
          },
        });
        await tx.emailAccount.update({ where: { id: account.id }, data: { lastUid: uid } });
      });
    } catch (err) {
      const rolledBack = saved.filter((s) => !s.reused);
      await this.storage.deleteFiles(
        tenantSlug,
        rolledBack.map((s) => s.relativePath),
      );
      const rolledBackBytes = rolledBack.reduce((sum, s) => sum + s.sizeBytes, 0);
      if (rolledBackBytes > 0) {
        await this.decrUsageBytes(account.tenantId, rolledBackBytes);
      }
      if (isPrismaUniqueViolation(err, 'accountId_messageId')) {
        this.logger.debug(logCtx, 'Carrera perdida contra otro proceso, tratado como duplicado');
        await this.prisma.withTenant(account.tenantId, (tx) =>
          tx.emailAccount.update({ where: { id: account.id }, data: { lastUid: uid } }),
        );
        return { status: 'skipped', filesSaved: 0 };
      }
      this.logger.error({ ...logCtx, err }, 'Fallo al persistir el correo, se registra ERROR');
      await this.registerEmailError({
        tenantId: account.tenantId,
        accountId: account.id,
        messageId: parsed.messageId,
        uid,
        subject: parsed.subject,
        senderName: parsed.senderName,
        senderEmail: parsed.senderEmail,
        recipients: parsed.recipients,
        receivedAt: parsed.receivedAt,
        monthFolder,
        errorDetail: this.describeError(err),
      });
      return { status: 'error', filesSaved: 0 };
    }

    return { status: 'processed', filesSaved: saved.length };
  }

  private async persistEmail(params: {
    account: EmailAccount;
    parsed: Pick<
      ParsedEmailMessage,
      'messageId' | 'subject' | 'senderName' | 'senderEmail' | 'recipients' | 'receivedAt'
    >;
    uid: number;
    monthFolder: string;
    status: 'SIN_ADJUNTOS';
    errorDetail?: string;
  }): Promise<boolean> {
    const { account, parsed, uid, monthFolder, status, errorDetail } = params;
    try {
      await this.prisma.withTenant(account.tenantId, async (tx) => {
        await tx.processedEmail.create({
          data: {
            tenantId: account.tenantId,
            accountId: account.id,
            messageId: parsed.messageId,
            uid,
            subject: parsed.subject,
            senderName: parsed.senderName,
            senderEmail: parsed.senderEmail,
            recipients: parsed.recipients,
            receivedAt: parsed.receivedAt,
            monthFolder,
            attachmentCount: 0,
            status,
            errorDetail,
          },
        });
        await tx.emailAccount.update({ where: { id: account.id }, data: { lastUid: uid } });
      });
      return true;
    } catch (err) {
      if (isPrismaUniqueViolation(err, 'accountId_messageId')) {
        await this.prisma.withTenant(account.tenantId, (tx) =>
          tx.emailAccount.update({ where: { id: account.id }, data: { lastUid: uid } }),
        );
        return false;
      }
      throw err;
    }
  }

  private async registerEmailError(params: {
    tenantId: string;
    accountId: string;
    messageId: string;
    uid: number;
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    recipients?: string[];
    receivedAt?: Date;
    monthFolder?: string;
    errorDetail: string;
  }): Promise<void> {
    const receivedAt = params.receivedAt ?? new Date();
    const monthFolder = params.monthFolder ?? this.storage.resolveMonthFolder(receivedAt);
    try {
      await this.prisma.withTenant(params.tenantId, async (tx) => {
        await tx.processedEmail.create({
          data: {
            tenantId: params.tenantId,
            accountId: params.accountId,
            messageId: params.messageId,
            uid: params.uid,
            subject: params.subject ?? '',
            senderName: params.senderName ?? '',
            senderEmail: params.senderEmail ?? '',
            recipients: params.recipients ?? [],
            receivedAt,
            monthFolder,
            status: 'ERROR',
            errorDetail: params.errorDetail,
          },
        });
        await tx.emailAccount.update({
          where: { id: params.accountId },
          data: { lastUid: params.uid },
        });
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err, 'accountId_messageId')) return;
      this.logger.error(
        { accountId: params.accountId, messageId: params.messageId, err },
        'No se pudo registrar el ProcessedEmail de error',
      );
    }
  }

  private async onConnectionFailure(
    tenantId: string,
    accountId: string,
    syncId: string,
    err: ImapConnectionError,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.emailAccount.update({ where: { id: accountId }, data: { lastError: err.message } }),
    );

    if (err.code !== 'IMAP_AUTH_FAILED') {
      this.logger.error(
        { accountId, syncId, code: err.code },
        'Sync abortado por fallo de conexión IMAP',
      );
      return;
    }

    const key = authFailKey(accountId);
    const failCount = await this.redis.incr(key);
    await this.redis.expire(key, AUTH_FAIL_TTL_SECONDS);
    this.logger.error({ accountId, syncId, failCount }, 'Fallo de autenticación IMAP');

    if (failCount >= AUTH_FAIL_THRESHOLD) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.emailAccount.update({
          where: { id: accountId },
          data: { status: 'ERROR_AUTH', lastError: err.message },
        }),
      );
      await this.scheduler.removeRepeatable(accountId);
      this.logger.error(
        { accountId, syncId },
        'Cuenta pasó a ERROR_AUTH tras 3 fallos de autenticación consecutivos',
      );
    }
  }

  private async finalizeSyncLog(
    tenantId: string,
    syncLogId: string,
    counters: SyncCounters,
    status: SyncStatus,
    errorDetail?: string,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.syncLog.update({
        where: { id: syncLogId },
        data: { ...counters, status, errorDetail, finishedAt: new Date() },
      }),
    );
  }

  private usageKey(tenantId: string): string {
    return `usage:bytes:${tenantId}`;
  }

  private async getUsageBytes(tenantId: string): Promise<number> {
    const raw = await this.redis.get(this.usageKey(tenantId));
    return raw ? Number(raw) : 0;
  }

  private async incrUsageBytes(tenantId: string, bytes: number): Promise<void> {
    await this.redis.incrby(this.usageKey(tenantId), bytes);
  }

  private async decrUsageBytes(tenantId: string, bytes: number): Promise<void> {
    await this.redis.decrby(this.usageKey(tenantId), bytes);
  }

  /** Reconcilia el contador de Redis contra la BD al cerrar cada SyncLog (skill tenancy
   * regla 17): corrige cualquier drift (crashes, borrados manuales, datos migrados). */
  private async reconcileUsage(tenantId: string): Promise<void> {
    const result = await this.prisma.withTenant(tenantId, (tx) =>
      tx.attachment.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
    );
    await this.redis.set(this.usageKey(tenantId), String(result._sum.sizeBytes ?? 0));
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : 'Error desconocido al procesar el correo';
  }
}
