import { Controller, Get, Query, Res, UnprocessableEntityException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import archiver from 'archiver';
import { ExportService, ManifestEntry } from './export.service';
import { ExportManifestDto } from './dto/export-manifest.dto';
import { ExportArchiveDto } from './dto/export-archive.dto';
import { StorageService } from '../storage/storage.service';
import { AppConfigService } from '../config/app-config.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  @Get('manifest')
  async manifest(@Query() dto: ExportManifestDto, @CurrentTenant() ctx: TenantContext) {
    return this.exportService.manifest(ctx, dto);
  }

  /** RF-07.3: ZIP en streaming, nunca materializado completo en memoria/disco. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('archive')
  async archive(
    @Query() dto: ExportArchiveDto,
    @CurrentTenant() ctx: TenantContext,
    @Res() res: Response,
  ): Promise<void> {
    const total = await this.exportService.countForArchive(ctx, dto);
    if (total > this.config.exportMaxZipFiles) {
      throw new UnprocessableEntityException({
        error: 'EXPORT_TOO_LARGE',
        message: `El filtro incluye ${total} archivos, más del límite de ${this.config.exportMaxZipFiles}. Acotá por mes o usá el manifiesto con descarga individual.`,
      });
    }

    const rows = await this.exportService.findAllForArchive(ctx, dto);

    const zipName = `export_${dto.accountId}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const zip = archiver('zip', { zlib: { level: 9 } });
    // Una vez que empezó el streaming ya se enviaron headers 200: ante un error
    // solo queda cortar la conexión, no se puede mandar un JSON de error limpio.
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);

    const manifestEntries: ManifestEntry[] = [];
    for (const row of rows) {
      const entry = this.exportService.toManifestEntry(ctx.tenantSlug!, row);
      manifestEntries.push(entry);
      if (entry.missing) continue;
      const absolutePath = this.storage.resolveSafe(ctx.tenantSlug!, row.relativePath);
      zip.file(absolutePath, { name: row.relativePath });
    }
    zip.append(JSON.stringify(manifestEntries, null, 2), { name: 'manifest.json' });

    await zip.finalize();
  }
}
