import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { TenantContext } from '../tenancy/tenant-context';

interface RequestWithTenant extends Request {
  tenantContext?: TenantContext;
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<RequestWithTenant>();
    if (!request.tenantContext) {
      throw new Error('CurrentTenant usado en una ruta sin AuthGuard aplicado');
    }
    return request.tenantContext;
  },
);
