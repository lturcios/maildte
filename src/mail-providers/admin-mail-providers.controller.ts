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
import { MailProvidersService } from './mail-providers.service';
import { CreateMailProviderDto } from './dto/create-mail-provider.dto';
import { UpdateMailProviderDto } from './dto/update-mail-provider.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

/** Administración del catálogo maestro de servicios de correo (Addendum 09). */
@Controller('admin/mail-providers')
@Roles(Role.SUPERADMIN)
export class AdminMailProvidersController {
  constructor(private readonly providers: MailProvidersService) {}

  @Get()
  async findAll() {
    const data = await this.providers.findAllForAdmin();
    return { data };
  }

  /**
   * Uso de todos los perfiles en una sola pasada, para la tabla de
   * administración. Declarado ANTES de `:id` a propósito: si no, la ruta
   * "usage" entraría por el handler del parámetro.
   */
  @Get('usage')
  async usageAll() {
    const data = await this.providers.usageAll();
    return { data };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.providers.findOne(id);
    return { data };
  }

  @Post()
  async create(@Body() dto: CreateMailProviderDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.providers.create(dto, ctx);
    return { data };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMailProviderDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.providers.update(id, dto, ctx);
    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ): Promise<void> {
    await this.providers.remove(id, ctx);
  }

  /** Cuántas cuentas y organizaciones dependen del perfil (alimenta la confirmación del PATCH). */
  @Get(':id/usage')
  async usage(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.providers.usage(id);
    return { data };
  }

  /** Alcance del host:puerto del perfil, sin credenciales. */
  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  async probe(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.providers.probe(id);
    return { data };
  }
}
