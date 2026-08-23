import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../prisma/prisma-errors';
import { PasswordService } from '../common/crypto/password.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersDto } from './dto/list-users.dto';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type SafeUser = Prisma.UserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

const USER_NOT_FOUND = { error: 'USER_NOT_FOUND', message: 'Usuario no encontrado' };
const USER_EMAIL_EXISTS = {
  error: 'USER_EMAIL_EXISTS',
  message: 'Ya existe un usuario registrado con este correo',
};

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
  ) {}

  async findAll(ctx: TenantContext, dto: ListUsersDto): Promise<Paginated<SafeUser>> {
    const tenantId = this.requireTenantId(ctx);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { tenantId },
        select: SAFE_USER_SELECT,
        skip: (dto.page - 1) * dto.limit,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where: { tenantId } }),
    ]);
    return { data, meta: { page: dto.page, limit: dto.limit, total } };
  }

  async findOne(ctx: TenantContext, id: string): Promise<SafeUser> {
    const tenantId = this.requireTenantId(ctx);
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: SAFE_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException(USER_NOT_FOUND);
    }
    return user;
  }

  async create(ctx: TenantContext, dto: CreateUserDto): Promise<SafeUser> {
    const tenantId = this.requireTenantId(ctx);
    const passwordHash = await this.password.hash(dto.password);

    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.user.create({
          data: {
            tenantId,
            email: dto.email,
            name: dto.name,
            passwordHash,
            role: dto.role ?? 'MIEMBRO',
          },
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

  async update(ctx: TenantContext, id: string, dto: UpdateUserDto): Promise<SafeUser> {
    const tenantId = this.requireTenantId(ctx);
    await this.findOne(ctx, id); // 404 si no existe o es de otro tenant

    const data: Prisma.UserUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.password !== undefined
        ? { passwordHash: await this.password.hash(dto.password) }
        : {}),
    };

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id }, data, select: SAFE_USER_SELECT }),
    );
  }

  /** No hay borrado físico de usuarios (sin deletedAt en el modelo, a diferencia de
   * EmailAccount): "eliminar" desactiva, igual que el resto del proyecto. */
  async remove(ctx: TenantContext, id: string): Promise<void> {
    const tenantId = this.requireTenantId(ctx);
    await this.findOne(ctx, id);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id }, data: { active: false } }),
    );
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no gestiona usuarios de tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
