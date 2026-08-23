import { Controller, Get, Query } from '@nestjs/common';
import { SyncLogsService } from './sync-logs.service';
import { ListSyncLogsDto } from './dto/list-sync-logs.dto';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('sync-logs')
export class SyncLogsController {
  constructor(private readonly syncLogs: SyncLogsService) {}

  @Get()
  async findAll(@Query() dto: ListSyncLogsDto, @CurrentTenant() ctx: TenantContext) {
    return this.syncLogs.findAll(ctx, dto);
  }
}
