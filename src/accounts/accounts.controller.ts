import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { ResyncAccountDto } from './dto/resync-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  @Roles(Role.ADMIN)
  async create(@Body() dto: CreateAccountDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.accounts.create(dto, ctx);
    return { data };
  }

  @Get()
  async findAll(@CurrentTenant() ctx: TenantContext) {
    const data = await this.accounts.findAll(ctx);
    return { data };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.accounts.findOne(ctx, id);
    return { data };
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.accounts.update(ctx, id, dto);
    return { data };
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ): Promise<void> {
    await this.accounts.remove(ctx, id);
  }

  @Post(':id/test')
  @Roles(Role.ADMIN)
  async test(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.accounts.testConnection(ctx, id);
    return { data };
  }

  @Post(':id/sync')
  @Roles(Role.ADMIN)
  async sync(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.accounts.triggerManualSync(ctx, id);
    return { data };
  }

  @Post(':id/resync')
  @Roles(Role.ADMIN)
  async resync(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResyncAccountDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.accounts.resyncFrom(ctx, id, dto);
    return { data };
  }
}
