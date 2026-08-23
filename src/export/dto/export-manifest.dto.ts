import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export class ExportManifestDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsISO8601()
  since?: string;

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
