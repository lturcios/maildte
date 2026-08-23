import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @MaxLength(120)
  alias!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(255)
  imapHost!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  imapPort!: number;

  @IsBoolean()
  imapSecure!: boolean;

  @IsString()
  @MaxLength(255)
  imapUser!: string;

  @IsString()
  @MinLength(1)
  imapPassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mailbox?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  syncInterval?: number;
}
