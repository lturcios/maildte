import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttachmentType, Prisma } from '@prisma/client';
import { existsSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ExportManifestDto } from './dto/export-manifest.dto';
import { ExportArchiveDto } from './dto/export-archive.dto';

export interface ManifestEntry {
  attachmentId: string;
  relativePath: string;
  fileType: AttachmentType;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  receivedAt: Date;
  senderEmail: string;
  missing: boolean;
}

export interface ManifestPage {
  data: ManifestEntry[];
  meta: {
    nextCursor: string | null;
    maxCreatedAt: Date | null;
    totalFiles: number;
    totalBytes: number;
    missingFiles: number;
  };
}

const ATTACHMENT_SELECT = {
  id: true,
  relativePath: true,
  fileType: true,
  sizeBytes: true,
  sha256: true,
  createdAt: true,
  email: { select: { receivedAt: true, senderEmail: true } },
} satisfies Prisma.AttachmentSelect;

type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof ATTACHMENT_SELECT }>;

const INVALID_CURSOR = { error: 'INVALID_CURSOR', message: 'El cursor indicado no existe' };
const ACCOUNT_NOT_FOUND = { error: 'ACCOUNT_NOT_FOUND', message: 'Cuenta no encontrada' };

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** RF-07.1: manifiesto paginado por cursor (createdAt asc, id asc como desempate). */
  async manifest(ctx: TenantContext, dto: ExportManifestDto): Promise<ManifestPage> {
    const tenantId = this.requireTenantId(ctx);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertAccountOwnership(tx, tenantId, dto.accountId);
      const baseWhere = this.buildWhere(tenantId, dto.accountId, dto.since, dto.month);
      const cursorWhere = await this.resolveCursorWhere(tx, tenantId, dto.cursorId);
      const where: Prisma.AttachmentWhereInput = { ...baseWhere, ...cursorWhere };

      const [rows, aggregate] = await Promise.all([
        tx.attachment.findMany({
          where,
          select: ATTACHMENT_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: dto.limit + 1,
        }),
        // Agregado sobre el filtro base (sin cursor): da al cliente un objetivo estable
        // (maxCreatedAt/totalFiles/totalBytes) independiente de en qué página está parado.
        tx.attachment.aggregate({
          where: baseWhere,
          _count: { _all: true },
          _sum: { sizeBytes: true },
          _max: { createdAt: true },
        }),
      ]);

      const hasMore = rows.length > dto.limit;
      const page = hasMore ? rows.slice(0, dto.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      const data = page.map((row) => this.toManifestEntry(ctx.tenantSlug!, row));
      const missingFiles = data.filter((entry) => entry.missing).length;

      return {
        data,
        meta: {
          nextCursor,
          maxCreatedAt: aggregate._max.createdAt,
          totalFiles: aggregate._count._all,
          totalBytes: aggregate._sum.sizeBytes ?? 0,
          missingFiles,
        },
      };
    });
  }

  /** RF-07.3: todas las filas que matchean el filtro, sin paginar (uso exclusivo del ZIP). */
  async findAllForArchive(ctx: TenantContext, dto: ExportArchiveDto): Promise<AttachmentRow[]> {
    const tenantId = this.requireTenantId(ctx);
    const where = this.buildWhere(tenantId, dto.accountId, dto.since, dto.month);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertAccountOwnership(tx, tenantId, dto.accountId);
      return tx.attachment.findMany({
        where,
        select: ATTACHMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  async countForArchive(ctx: TenantContext, dto: ExportArchiveDto): Promise<number> {
    const tenantId = this.requireTenantId(ctx);
    const where = this.buildWhere(tenantId, dto.accountId, dto.since, dto.month);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertAccountOwnership(tx, tenantId, dto.accountId);
      return tx.attachment.count({ where });
    });
  }

  toManifestEntry(tenantSlug: string, row: AttachmentRow): ManifestEntry {
    return {
      attachmentId: row.id,
      relativePath: row.relativePath,
      fileType: row.fileType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      createdAt: row.createdAt,
      receivedAt: row.email.receivedAt,
      senderEmail: row.email.senderEmail,
      missing: this.isMissing(tenantSlug, row.relativePath),
    };
  }

  isMissing(tenantSlug: string, relativePath: string): boolean {
    try {
      const absolute = this.storage.resolveSafe(tenantSlug, relativePath);
      return !existsSync(absolute);
    } catch {
      return true;
    }
  }

  private buildWhere(
    tenantId: string,
    accountId: string,
    since?: string,
    month?: string,
  ): Prisma.AttachmentWhereInput {
    return {
      tenantId,
      email: {
        accountId,
        ...(month ? { monthFolder: month } : {}),
      },
      ...(since ? { createdAt: { gt: new Date(since) } } : {}),
    };
  }

  private async resolveCursorWhere(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cursorId?: string,
  ): Promise<Prisma.AttachmentWhereInput> {
    if (!cursorId) return {};
    const anchor = await tx.attachment.findFirst({
      where: { id: cursorId, tenantId },
      select: { id: true, createdAt: true },
    });
    if (!anchor) {
      throw new BadRequestException(INVALID_CURSOR);
    }
    return {
      OR: [
        { createdAt: { gt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { gt: anchor.id } },
      ],
    };
  }

  /** accountId es un filtro de query, no un recurso propio del tenant: si pertenece a otro
   * tenant (o no existe), 404 — nunca una respuesta vacía que podría confundirse con "sin
   * archivos todavía" (skill tenancy: acceso cross-tenant se ve como si no existiera). */
  private async assertAccountOwnership(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
  ): Promise<void> {
    const account = await tx.emailAccount.findFirst({
      where: { id: accountId, tenantId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no exporta datos de negocio de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
