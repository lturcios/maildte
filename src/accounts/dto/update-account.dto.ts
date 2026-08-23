import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  alias?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  imapHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  imapPort?: number;

  @IsOptional()
  @IsBoolean()
  imapSecure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  imapUser?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  imapPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mailbox?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  syncInterval?: number;

  /** Solo activación manual; ERROR_AUTH es un estado auto-asignado, no seteable por API. */
  @IsOptional()
  @IsIn(['ACTIVA', 'INACTIVA'])
  status?: 'ACTIVA' | 'INACTIVA';
}
