import { IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';

export class ExportArchiveDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe tener formato YYYY-MM' })
  month?: string;
}
