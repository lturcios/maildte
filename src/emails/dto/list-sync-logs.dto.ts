import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { SyncStatus } from '@prisma/client';

export class ListSyncLogsDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsEnum(SyncStatus)
  status?: SyncStatus;

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
