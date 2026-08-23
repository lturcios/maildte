import { Controller, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async me(@CurrentTenant() ctx: TenantContext) {
    const data = await this.auth.getProfile(ctx.actor.type, ctx.actor.id);
    return { data };
  }
}
