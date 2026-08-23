import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { createHash } from 'crypto';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { AccessTokenPayload } from '../jwt-payload';

const INVALID_TOKEN = { error: 'INVALID_TOKEN', message: 'Token inválido o expirado' };
const UNAUTHENTICATED = {
  error: 'UNAUTHENTICATED',
  message: 'Se requiere un token JWT o una API key válida',
};
const TENANT_SUSPENDED = {
  error: 'TENANT_SUSPENDED',
  message: 'La cuenta de tu organización está suspendida',
};

export interface RequestWithTenant extends Request {
  tenantContext?: TenantContext;
}

/**
 * Reemplaza al ApiKeyGuard global del MVP: acepta JWT de usuario O TenantApiKey
 * (composición OR), arma el TenantContext y lo cuelga en el request para que
 * @CurrentTenant() y los services de negocio lo consuman. Nunca confía en un
 * tenantId provisto por el cliente: siempre lo deriva del token/key validados.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithTenant>();

    const bearerToken = this.extractBearerToken(request);
    if (bearerToken) {
      request.tenantContext = await this.resolveFromJwt(bearerToken);
      return true;
    }

    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
      request.tenantContext = await this.resolveFromApiKey(apiKeyHeader);
      return true;
    }

    throw new UnauthorizedException(UNAUTHENTICATED);
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  private async resolveFromJwt(token: string): Promise<TenantContext> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException(INVALID_TOKEN);
    }

    if (payload.tenantId === null) {
      return {
        tenantId: null,
        tenantSlug: null,
        actor: { type: 'user', id: payload.sub, role: payload.role },
      };
    }

    const tenantSlug = await this.assertTenantActive(payload.tenantId);
    return {
      tenantId: payload.tenantId,
      tenantSlug,
      actor: { type: 'user', id: payload.sub, role: payload.role },
    };
  }

  private async resolveFromApiKey(rawKey: string): Promise<TenantContext> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.prisma.tenantApiKey.findUnique({
      where: { keyHash },
      include: { tenant: true },
    });

    if (!apiKey || apiKey.revokedAt) {
      throw new UnauthorizedException({
        error: 'INVALID_API_KEY',
        message: 'API Key inválida o revocada',
      });
    }
    if (apiKey.tenant.status === 'SUSPENDIDO') {
      throw new ForbiddenException(TENANT_SUSPENDED);
    }

    this.touchLastUsed(apiKey.id, apiKey.tenantId);

    return {
      tenantId: apiKey.tenantId,
      tenantSlug: apiKey.tenant.slug,
      actor: { type: 'apikey', id: apiKey.id, role: 'MIEMBRO' },
    };
  }

  /** Devuelve el slug (evita un segundo lookup: StorageService lo necesita siempre). */
  private async assertTenantActive(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, slug: true },
    });
    if (!tenant) {
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    if (tenant.status === 'SUSPENDIDO') {
      throw new ForbiddenException(TENANT_SUSPENDED);
    }
    return tenant.slug;
  }

  /** Best-effort, no bloquea la request: métrica de uso, no es crítico si falla. */
  private touchLastUsed(apiKeyId: string, tenantId: string): void {
    this.prisma
      .withTenant(tenantId, (tx) =>
        tx.tenantApiKey.update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } }),
      )
      .catch((err: unknown) => {
        this.logger.warn({ err, apiKeyId }, 'No se pudo actualizar lastUsedAt de la API key');
      });
  }
}
