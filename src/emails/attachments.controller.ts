import { Controller, Get, GoneException, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { EmailsService } from './emails.service';
import { StorageService } from '../storage/storage.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly emails: EmailsService,
    private readonly storage: StorageService,
  ) {}

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() ctx: TenantContext,
    @Res() res: Response,
  ): Promise<void> {
    const attachment = await this.emails.getAttachment(ctx, id);
    const absolutePath = this.storage.resolveSafe(ctx.tenantSlug!, attachment.relativePath);

    if (!existsSync(absolutePath)) {
      throw new GoneException({
        error: 'FILE_MISSING',
        message: 'El archivo ya no está disponible en el almacenamiento',
      });
    }

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', attachment.sizeBytes);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
    );
    createReadStream(absolutePath).pipe(res);
  }
}
