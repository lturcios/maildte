import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

const SAFE_API_KEY_SELECT = {
  id: true,
  name: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.TenantApiKeySelect;

type SafeApiKey = Prisma.TenantApiKeyGetPayload<{ select: typeof SAFE_API_KEY_SELECT }>;

const API_KEY_NOT_FOUND = { error: 'API_KEY_NOT_FOUND', message: 'API key no encontrada' };

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext): Promise<SafeApiKey[]> {
    const tenantId = this.requireTenantId(ctx);
    return this.prisma.tenantApiKey.findMany({
      where: { tenantId },
      select: SAFE_API_KEY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** La key en texto plano solo existe acá, en la respuesta de creación: nunca se persiste
   * ni se puede volver a consultar (formato mdte_{slug8}_{random32}, se guarda solo su sha256). */
  async create(ctx: TenantContext, dto: CreateApiKeyDto): Promise<SafeApiKey & { apiKey: string }> {
    const tenantId = this.requireTenantId(ctx);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    if (!tenant) {
      throw new NotFoundException(API_KEY_NOT_FOUND);
    }

    const slugSegment = tenant.slug.slice(0, 8);
    const randomSegment = randomBytes(24).toString('base64url');
    const apiKey = `mdte_${slugSegment}_${randomSegment}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantApiKey.create({
        data: { tenantId, name: dto.name, keyHash },
        select: SAFE_API_KEY_SELECT,
      }),
    );

    return { ...created, apiKey };
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    const tenantId = this.requireTenantId(ctx);
    const existing = await this.prisma.tenantApiKey.findFirst({ where: { id, tenantId } });
    if (!existing) {
      throw new NotFoundException(API_KEY_NOT_FOUND);
    }
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantApiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
    );
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no gestiona API keys de tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
