import {
  IsBoolean,
  IsEmail,
  IsISO8601,
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

  /** Punto de partida de la primera sincronización (RF-02.2). Si se omite, se fija a now(). */
  @IsOptional()
  @IsISO8601()
  syncFromDate?: string;
}
