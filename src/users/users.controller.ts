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
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async findAll(@Query() dto: ListUsersDto, @CurrentTenant() ctx: TenantContext) {
    return this.users.findAll(ctx, dto);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.users.findOne(ctx, id);
    return { data };
  }

  @Post()
  async create(@Body() dto: CreateUserDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.users.create(ctx, dto);
    return { data };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.users.update(ctx, id, dto);
    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ): Promise<void> {
    await this.users.remove(ctx, id);
  }
}
