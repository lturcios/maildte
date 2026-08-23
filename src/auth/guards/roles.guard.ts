import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RequestWithTenant } from './auth.guard';

/** Corre después de AuthGuard: exige que request.tenantContext.actor.role esté en @Roles(...). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const role = request.tenantContext?.actor.role;

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'Tu rol no tiene permiso para realizar esta acción',
      });
    }
    return true;
  }
}
