import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('summary')
  async summary(@CurrentTenant() ctx: TenantContext) {
    const data = await this.stats.summary(ctx);
    return { data };
  }
}
