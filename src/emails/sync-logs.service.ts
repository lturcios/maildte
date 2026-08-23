import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, SyncLog } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ListSyncLogsDto } from './dto/list-sync-logs.dto';
import { Paginated } from './emails.service';

@Injectable()
export class SyncLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext, dto: ListSyncLogsDto): Promise<Paginated<SyncLog>> {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no consulta datos de negocio de un tenant por esta ruta',
      });
    }
    const tenantId = ctx.tenantId;

    const where: Prisma.SyncLogWhereInput = {
      tenantId,
      ...(dto.accountId ? { accountId: dto.accountId } : {}),
      ...(dto.status ? { status: dto.status } : {}),
    };

    const [data, total] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.syncLog.findMany({
          where,
          skip: (dto.page - 1) * dto.limit,
          take: dto.limit,
          orderBy: { startedAt: 'desc' },
        }),
        tx.syncLog.count({ where }),
      ]),
    );

    return { data, meta: { page: dto.page, limit: dto.limit, total } };
  }
}
