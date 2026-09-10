import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Role } from '@prisma/client';
import { PurchaseBookService } from './purchase-book.service';
import { PartiesService } from './parties.service';
import { ExportPurchaseBookService } from './export/export-purchase-book.service';
import { ExportPurchaseBookDto } from './dto/export-purchase-book.dto';
import { formatCsvRow } from './export/anexo-csv';
import { writeAnexoXlsx } from './export/anexo-xlsx';
import { ListPurchaseDocumentsDto } from './dto/list-purchase-documents.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';
import { ListPartiesDto } from './dto/list-parties.dto';
import { UpdatePartyDefaultsDto } from './dto/update-party-defaults.dto';
import { ReprocessDto } from './dto/reprocess.dto';
import { ListParseResultsDto } from './dto/list-parse-results.dto';
import { PurchaseActivityService } from './activity/purchase-activity.service';
import { PurchaseActivitySeedService } from './activity/purchase-activity-seed.service';
import { ListPurchaseActivitiesDto } from './dto/list-purchase-activities.dto';
import { CreatePurchaseActivityDto } from './dto/create-purchase-activity.dto';
import { UpdatePurchaseActivityDto } from './dto/update-purchase-activity.dto';
import {
  ClearSupplierActivityDefaultDto,
  ListSupplierActivityDefaultsDto,
  SetSupplierActivityDefaultDto,
} from './dto/supplier-activity-default.dto';
import { ApplyActivitySeedDto, ProposeActivitySeedDto } from './dto/activity-seed.dto';
import { ANEXO_CATALOGS } from './anexo/classification-catalogs';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

/**
 * Libro de compras (Addendum 10, §7).
 *
 * Lectura para MIEMBRO y ADMIN; clasificación, defaults del receptor y
 * reprocesamiento solo para ADMIN, porque son decisiones contables.
 * SUPERADMIN no pasa: los servicios lanzan FORBIDDEN_ROLE.
 */
@Controller('purchase-book')
export class PurchaseBookController {
  constructor(
    private readonly purchaseBook: PurchaseBookService,
    private readonly parties: PartiesService,
    private readonly exportService: ExportPurchaseBookService,
    private readonly activities: PurchaseActivityService,
    private readonly activitySeed: PurchaseActivitySeedService,
  ) {}

  /**
   * Anexo 3 "Detalle de Compras" en CSV o XLSX.
   *
   * Los topes se validan ANTES de tocar la respuesta: una vez enviados los
   * headers 200 ya no se puede devolver un JSON de error limpio (mismo criterio
   * que el ZIP de /export/archive).
   */
  @Get('export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(
    @Query() dto: ExportPurchaseBookDto,
    @CurrentTenant() ctx: TenantContext,
    @Res() res: Response,
  ): Promise<void> {
    const { rows, receptorNit } = await this.exportService.collectRows(ctx, dto);

    if (dto.format === 'csv') {
      const fileName = this.exportService.buildFileName(dto, 'csv', receptorNit);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

      // Sin BOM y sin encabezado, por exigencia del portal de Hacienda.
      for (const cells of rows) {
        // Backpressure: si el socket se llena, se espera el drain en vez de
        // acumular todo el archivo en el buffer del proceso.
        if (!res.write(formatCsvRow(cells))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
      return;
    }

    const fileName = this.exportService.buildFileName(dto, 'xlsx', receptorNit);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await writeAnexoXlsx(rows, res, { header: dto.header ?? false });
  }

  @Get('documents')
  async findAll(@Query() dto: ListPurchaseDocumentsDto, @CurrentTenant() ctx: TenantContext) {
    return this.purchaseBook.findAll(ctx, dto);
  }

  @Get('documents/summary')
  async summary(@Query() dto: ListPurchaseDocumentsDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.purchaseBook.summary(ctx, dto);
    return { data };
  }

  @Get('documents/:id')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() ctx: TenantContext) {
    const data = await this.purchaseBook.findOne(ctx, id);
    return { data };
  }

  @Patch('documents/:id/classification')
  @Roles(Role.ADMIN)
  async updateClassification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassificationDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.purchaseBook.updateClassification(ctx, id, dto);
    return { data };
  }

  @Get('parties')
  async findParties(@Query() dto: ListPartiesDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.parties.findAll(ctx, dto);
    return { data };
  }

  @Patch('parties/:id/defaults')
  @Roles(Role.ADMIN)
  async updatePartyDefaults(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartyDefaultsDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.parties.updateDefaults(ctx, id, dto);
    return { data };
  }

  // ---------------------------------------------------------------------------
  // Actividad del contribuyente (Addendum 11, fase 3)
  //
  // Todo el bloque es ADMIN: el catálogo de unidades de negocio y el mapeo de
  // proveedores son criterio contable, igual que la clasificación Q–T.
  //
  // Las rutas literales `activities/seed` van declaradas ANTES de las que
  // llevan `:id`, para que Nest no intente resolver "seed" como UUID.
  // ---------------------------------------------------------------------------

  /** Propuesta de siembra. Solo lectura: no escribe nada. */
  @Get('activities/seed')
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async proposeActivitySeed(
    @Query() dto: ProposeActivitySeedDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activitySeed.propose(ctx, dto);
    return { data };
  }

  /** Aplica la siembra ya revisada. Exige `confirm: true` en el body. */
  @Post('activities/seed')
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async applyActivitySeed(@Body() dto: ApplyActivitySeedDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.activitySeed.apply(ctx, dto);
    return { data };
  }

  @Get('activities')
  @Roles(Role.ADMIN)
  async findActivities(
    @Query() dto: ListPurchaseActivitiesDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.findAll(ctx, dto);
    return { data };
  }

  @Post('activities')
  @Roles(Role.ADMIN)
  async createActivity(
    @Body() dto: CreatePurchaseActivityDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.create(ctx, dto);
    return { data };
  }

  @Patch('activities/:id')
  @Roles(Role.ADMIN)
  async updateActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseActivityDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.update(ctx, id, dto);
    return { data };
  }

  /** Retiro de una actividad sin romper lo que la referencia. */
  @Post('activities/:id/deactivate')
  @Roles(Role.ADMIN)
  async deactivateActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.deactivate(ctx, id);
    return { data };
  }

  /** Borrado definitivo. 422 si algún mapeo o documento la referencia. */
  @Delete('activities/:id')
  @Roles(Role.ADMIN)
  async removeActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.remove(ctx, id);
    return { data };
  }

  /** Mapeo del receptor, ordenado por volumen de compras del proveedor. */
  @Get('supplier-activity-defaults')
  @Roles(Role.ADMIN)
  async findSupplierActivityDefaults(
    @Query() dto: ListSupplierActivityDefaultsDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.findSupplierDefaults(ctx, dto);
    return { data };
  }

  @Put('supplier-activity-defaults')
  @Roles(Role.ADMIN)
  async setSupplierActivityDefault(
    @Body() dto: SetSupplierActivityDefaultDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.setSupplierDefault(ctx, dto);
    return { data };
  }

  @Delete('supplier-activity-defaults')
  @Roles(Role.ADMIN)
  async clearSupplierActivityDefault(
    @Query() dto: ClearSupplierActivityDefaultDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    const data = await this.activities.clearSupplierDefault(ctx, dto);
    return { data };
  }

  /** Catálogos de Hacienda. Estáticos: el panel los cachea una vez por sesión. */
  @Get('catalogs')
  catalogs() {
    return { data: ANEXO_CATALOGS };
  }

  @Get('parse-results')
  @Roles(Role.ADMIN)
  async parseResults(@Query() dto: ListParseResultsDto, @CurrentTenant() ctx: TenantContext) {
    return this.purchaseBook.listParseResults(ctx, dto);
  }

  /**
   * Encola el parseo de adjuntos JSON. Throttle bajo porque cada llamada puede
   * empujar miles de jobs a Redis.
   */
  @Post('reprocess')
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async reprocess(@Body() dto: ReprocessDto, @CurrentTenant() ctx: TenantContext) {
    const data = await this.purchaseBook.reprocess(ctx, dto);
    return { data };
  }
}
