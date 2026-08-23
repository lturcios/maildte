import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Attachment, Prisma, ProcessedEmail } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ListEmailsDto } from './dto/list-emails.dto';

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

const EMAIL_NOT_FOUND = { error: 'EMAIL_NOT_FOUND', message: 'Correo no encontrado' };
const ATTACHMENT_NOT_FOUND = { error: 'ATTACHMENT_NOT_FOUND', message: 'Adjunto no encontrado' };

@Injectable()
export class EmailsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    ctx: TenantContext,
    dto: ListEmailsDto,
  ): Promise<Paginated<ProcessedEmail & { attachments: Attachment[] }>> {
    const tenantId = this.requireTenantId(ctx);
    const where = this.buildWhere(tenantId, dto);

    const [data, total] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.processedEmail.findMany({
          where,
          skip: (dto.page - 1) * dto.limit,
          take: dto.limit,
          orderBy: { receivedAt: 'desc' },
          include: { attachments: true },
        }),
        tx.processedEmail.count({ where }),
      ]),
    );

    return { data, meta: { page: dto.page, limit: dto.limit, total } };
  }

  async findOne(
    ctx: TenantContext,
    id: string,
  ): Promise<ProcessedEmail & { attachments: Attachment[] }> {
    const tenantId = this.requireTenantId(ctx);
    // findFirst con tenantId, nunca findUnique solo por id (skill tenancy): un correo de
    // otro tenant debe verse como si no existiera (404), no como un 403.
    const email = await this.prisma.withTenant(tenantId, (tx) =>
      tx.processedEmail.findFirst({ where: { id, tenantId }, include: { attachments: true } }),
    );
    if (!email) {
      throw new NotFoundException(EMAIL_NOT_FOUND);
    }
    return email;
  }

  async getAttachment(ctx: TenantContext, id: string): Promise<Attachment> {
    const tenantId = this.requireTenantId(ctx);
    const attachment = await this.prisma.withTenant(tenantId, (tx) =>
      tx.attachment.findFirst({ where: { id, tenantId } }),
    );
    if (!attachment) {
      throw new NotFoundException(ATTACHMENT_NOT_FOUND);
    }
    return attachment;
  }

  private buildWhere(tenantId: string, dto: ListEmailsDto): Prisma.ProcessedEmailWhereInput {
    return {
      // Siempre en el where, aunque withTenant + RLS ya acoten las filas (defensa en
      // profundidad explícita, skill tenancy).
      tenantId,
      ...(dto.accountId ? { accountId: dto.accountId } : {}),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.from || dto.to
        ? {
            receivedAt: {
              ...(dto.from ? { gte: new Date(dto.from) } : {}),
              ...(dto.to ? { lte: new Date(dto.to) } : {}),
            },
          }
        : {}),
      ...(dto.sender
        ? {
            OR: [
              { senderEmail: { contains: dto.sender, mode: 'insensitive' } },
              { senderName: { contains: dto.sender, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(dto.hasAttachments !== undefined
        ? { attachmentCount: dto.hasAttachments ? { gt: 0 } : { equals: 0 } }
        : {}),
    };
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no consulta datos de negocio de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
