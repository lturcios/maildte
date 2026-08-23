import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { PasswordService } from '../common/crypto/password.service';
import { AccessTokenPayload, RefreshTokenPayload } from './jwt-payload';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';

const INVALID_CREDENTIALS = {
  error: 'INVALID_CREDENTIALS',
  message: 'Email o contraseña incorrectos',
};
const INVALID_REFRESH = {
  error: 'INVALID_CREDENTIALS',
  message: 'El refresh token es inválido, expiró o ya fue usado',
};
const TENANT_SUSPENDED = {
  error: 'TENANT_SUSPENDED',
  message: 'La cuenta de tu organización está suspendida',
};

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    maxAccounts: number;
    maxStorageBytes: bigint;
  } | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly password: PasswordService,
  ) {}

  async login(email: string, plainPassword: string): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const valid = await this.password.verify(user.passwordHash, plainPassword);
    if (!valid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await this.assertTenantActiveFor(user);

    const accessToken = this.signAccessToken(user);
    const { token: refreshToken, jti } = this.signRefreshToken(user.id);

    await this.updateUserSession(user.id, user.tenantId, {
      lastLoginAt: new Date(),
      currentRefreshTokenHash: this.hashJti(jti),
    });

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active || !user.currentRefreshTokenHash) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    if (user.currentRefreshTokenHash !== this.hashJti(payload.jti)) {
      // Reuso de un refresh token ya rotado: invalidamos la sesión por las dudas
      // (posible token robado usado después de que el legítimo ya rotó).
      await this.updateUserSession(user.id, user.tenantId, { currentRefreshTokenHash: null });
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    await this.assertTenantActiveFor(user);

    const accessToken = this.signAccessToken(user);
    const { token: newRefreshToken, jti: newJti } = this.signRefreshToken(user.id);

    await this.updateUserSession(user.id, user.tenantId, {
      currentRefreshTokenHash: this.hashJti(newJti),
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(actorType: 'user' | 'apikey', userId: string): Promise<void> {
    if (actorType !== 'user') {
      throw new BadRequestException({
        error: 'INVALID_ACTOR',
        message: 'Logout solo aplica a sesiones de usuario',
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return;
    }
    await this.updateUserSession(user.id, user.tenantId, { currentRefreshTokenHash: null });
  }

  async getProfile(actorType: 'user' | 'apikey', userId: string): Promise<UserProfile> {
    if (actorType !== 'user') {
      throw new BadRequestException({
        error: 'INVALID_ACTOR',
        message: '/me solo aplica a sesiones de usuario',
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true },
    });
    if (!user) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenant: user.tenant
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            slug: user.tenant.slug,
            status: user.tenant.status,
            maxAccounts: user.tenant.maxAccounts,
            maxStorageBytes: user.tenant.maxStorageBytes,
          }
        : null,
    };
  }

  private async assertTenantActiveFor(user: Pick<User, 'tenantId'>): Promise<void> {
    if (!user.tenantId) {
      return; // SUPERADMIN
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { status: true },
    });
    if (!tenant || tenant.status === 'SUSPENDIDO') {
      throw new ForbiddenException(TENANT_SUSPENDED);
    }
  }

  private signAccessToken(user: Pick<User, 'id' | 'tenantId' | 'role'>): string {
    const payload: AccessTokenPayload = { sub: user.id, tenantId: user.tenantId, role: user.role };
    return this.jwt.sign(payload, { secret: this.config.jwtSecret, expiresIn: ACCESS_TOKEN_TTL });
  }

  private signRefreshToken(userId: string): { token: string; jti: string } {
    const jti = randomUUID();
    const payload: RefreshTokenPayload = { sub: userId, jti };
    const token = this.jwt.sign(payload, {
      secret: this.config.jwtRefreshSecret,
      expiresIn: REFRESH_TOKEN_TTL,
    });
    return { token, jti };
  }

  private hashJti(jti: string): string {
    return createHash('sha256').update(jti).digest('hex');
  }

  /** UPDATE en `users` está scoped por RLS: con tenant real hay que fijar el contexto;
   * SUPERADMIN (tenantId null) solo matchea la policy sin ningún contexto seteado. */
  private async updateUserSession(
    userId: string,
    tenantId: string | null,
    data: Prisma.UserUpdateInput,
  ): Promise<void> {
    if (tenantId) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.user.update({ where: { id: userId }, data }),
      );
    } else {
      await this.prisma.user.update({ where: { id: userId }, data });
    }
  }
}
