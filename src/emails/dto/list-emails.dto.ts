import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EmailStatus } from '@prisma/client';

export class ListEmailsDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sender?: string;

  @IsOptional()
  @IsEnum(EmailStatus)
  status?: EmailStatus;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  hasAttachments?: boolean;

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
