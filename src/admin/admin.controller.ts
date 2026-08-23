import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AdminService } from './admin.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CreateTenantAdminDto } from './dto/create-tenant-admin.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin/tenants')
@Roles(Role.SUPERADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  async findAll() {
    const data = await this.admin.findAll();
    return { data };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.admin.findOne(id);
    return { data };
  }

  @Post()
  async create(@Body() dto: CreateTenantDto) {
    const data = await this.admin.create(dto);
    return { data };
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    const data = await this.admin.update(id, dto);
    return { data };
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.admin.suspend(id);
    return { data };
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.admin.activate(id);
    return { data };
  }

  @Get(':id/usage')
  async usage(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.admin.usage(id);
    return { data };
  }

  @Post(':id/users')
  async createFirstAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTenantAdminDto,
  ) {
    const data = await this.admin.createFirstAdmin(id, dto);
    return { data };
  }
}
