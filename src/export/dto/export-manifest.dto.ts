import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export class ExportManifestDto {
  @IsUUID()
  accountId!: string;

  /** Cursor de archivado (`Attachment.createdAt`), contrato del CLI maildte-pull (RF-07.1). */
  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  /** Rango por fecha de recepción del correo (`ProcessedEmail.receivedAt`), igual que GET /emails. */
  @IsOptional()
  @IsISO8601()
  receivedFrom?: string;

  @IsOptional()
  @IsISO8601()
  receivedTo?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe tener formato YYYY-MM' })
  month?: string;

  @IsOptional()
  @IsUUID()
  cursorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 500;
}
