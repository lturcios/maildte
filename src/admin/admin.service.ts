import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../prisma/prisma-errors';
import { PasswordService } from '../common/crypto/password.service';
import { SyncScheduler } from '../sync/sync.scheduler';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CreateTenantAdminDto } from './dto/create-tenant-admin.dto';

const SAFE_TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  maxAccounts: true,
  maxStorageBytes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TenantSelect;

type SafeTenant = Prisma.TenantGetPayload<{ select: typeof SAFE_TENANT_SELECT }>;

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type SafeUser = Prisma.UserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

export interface TenantUsage {
  accounts: number;
  emailsByStatus: { status: string; count: number }[];
  totalFiles: number;
  totalBytes: number;
  recentErrors: { id: string; accountId: string; startedAt: Date; errorDetail: string | null }[];
}

const TENANT_NOT_FOUND = { error: 'TENANT_NOT_FOUND', message: 'Tenant no encontrado' };
const TENANT_SLUG_EXISTS = {
  error: 'TENANT_SLUG_EXISTS',
  message: 'Ya existe un tenant con ese slug',
};
const USER_EMAIL_EXISTS = {
  error: 'USER_EMAIL_EXISTS',
  message: 'Ya existe un usuario registrado con este correo',
};

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly scheduler: SyncScheduler,
  ) {}

  findAll(): Promise<SafeTenant[]> {
    return this.prisma.tenant.findMany({
      select: SAFE_TENANT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string): Promise<SafeTenant> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: SAFE_TENANT_SELECT,
    });
    if (!tenant) {
      throw new NotFoundException(TENANT_NOT_FOUND);
    }
    return tenant;
  }

  async create(dto: CreateTenantDto): Promise<SafeTenant> {
    try {
      return await this.prisma.tenant.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          ...(dto.maxAccounts !== undefined ? { maxAccounts: dto.maxAccounts } : {}),
          ...(dto.maxStorageBytes !== undefined
            ? { maxStorageBytes: BigInt(dto.maxStorageBytes) }
            : {}),
        },
        select: SAFE_TENANT_SELECT,
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err, 'slug')) {
        throw new ConflictException(TENANT_SLUG_EXISTS);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateTenantDto): Promise<SafeTenant> {
    await this.findOne(id);
    return this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.maxAccounts !== undefined ? { maxAccounts: dto.maxAccounts } : {}),
        ...(dto.maxStorageBytes !== undefined
          ? { maxStorageBytes: BigInt(dto.maxStorageBytes) }
          : {}),
      },
      select: SAFE_TENANT_SELECT,
    });
  }

  async suspend(id: string): Promise<SafeTenant> {
    const tenant = await this.findOne(id);
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: 'SUSPENDIDO' },
      select: SAFE_TENANT_SELECT,
    });

    if (tenant.status !== 'SUSPENDIDO') {
      const accounts = await this.prisma.withTenant(id, (tx) =>
        tx.emailAccount.findMany({ where: { tenantId: id }, select: { id: true } }),
      );
      for (const account of accounts) {
        await this.scheduler.removeRepeatable(account.id);
      }
    }
    return updated;
  }

  async activate(id: string): Promise<SafeTenant> {
    const tenant = await this.findOne(id);
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: 'ACTIVO' },
      select: SAFE_TENANT_SELECT,
    });

    if (tenant.status === 'SUSPENDIDO') {
      const accounts = await this.prisma.withTenant(id, (tx) =>
        tx.emailAccount.findMany({
          where: { tenantId: id, deletedAt: null },
          select: { id: true, tenantId: true, syncInterval: true, status: true, deletedAt: true },
        }),
      );
      for (const account of accounts) {
        await this.scheduler.syncRepeatableFor(account);
      }
    }
    return updated;
  }

  async usage(id: string): Promise<TenantUsage> {
    await this.findOne(id);

    const [accounts, emailsByStatus, fileStats, recentErrors] = await this.prisma.withTenant(
      id,
      (tx) =>
        Promise.all([
          tx.emailAccount.count({ where: { tenantId: id, deletedAt: null } }),
          tx.processedEmail.groupBy({
            by: ['status'],
            where: { tenantId: id },
            _count: { _all: true },
          }),
          tx.attachment.aggregate({
            where: { tenantId: id },
            _count: { _all: true },
            _sum: { sizeBytes: true },
          }),
          tx.syncLog.findMany({
            where: { tenantId: id, status: 'ERROR' },
            orderBy: { startedAt: 'desc' },
            take: 10,
            select: { id: true, accountId: true, startedAt: true, errorDetail: true },
          }),
        ]),
    );

    return {
      accounts,
      emailsByStatus: emailsByStatus.map((row) => ({ status: row.status, count: row._count._all })),
      totalFiles: fileStats._count._all,
      totalBytes: fileStats._sum.sizeBytes ?? 0,
      recentErrors,
    };
  }

  /** Onboarding: alta del primer ADMIN de un tenant recién creado. */
  async createFirstAdmin(tenantId: string, dto: CreateTenantAdminDto): Promise<SafeUser> {
    await this.findOne(tenantId);
    const passwordHash = await this.password.hash(dto.password);

    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.user.create({
          data: { tenantId, email: dto.email, name: dto.name, passwordHash, role: 'ADMIN' },
          select: SAFE_USER_SELECT,
        }),
      );
    } catch (err) {
      if (isPrismaUniqueViolation(err, 'email')) {
        throw new ConflictException(USER_EMAIL_EXISTS);
      }
      throw err;
    }
  }
}
