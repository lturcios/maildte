import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { EmailsService } from './emails.service';
import { ListEmailsDto } from './dto/list-emails.dto';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('emails')
export class EmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Get()
  async findAll(@Query() dto: ListEmailsDto, @CurrentTenant() ctx: TenantContext) {
    return this.emails.findAll(ctx, dto);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.emails.findOne(ctx, id);
    return { data };
  }
}
