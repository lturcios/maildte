import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('api-keys')
@Roles(Role.ADMIN)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  async findAll(@CurrentTenant() ctx: TenantContext) {
    const data = await this.apiKeys.findAll(ctx);
    return { data };
  }

  @Post()
  async create(@Body() dto: CreateApiKeyDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.apiKeys.create(ctx, dto);
    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ): Promise<void> {
    await this.apiKeys.revoke(ctx, id);
  }
}
