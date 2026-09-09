import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DteParseStatus } from '@prisma/client';

/** Vista operativa de fallos de parseo (Addendum 10, §7). Solo ADMIN. */
export class ListParseResultsDto {
  @IsOptional()
  @IsEnum(DteParseStatus)
  status?: DteParseStatus;

  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}
