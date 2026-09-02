import {
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @MaxLength(120)
  alias!: string;

  @IsEmail()
  email!: string;

  /**
   * Perfil del catálogo maestro (Addendum 09). Si viene, manda el perfil y los
   * tres campos imap* de abajo se ignoran. Si se omite, la cuenta es de
   * "servidor personalizado" y esos tres campos pasan a ser obligatorios.
   */
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ValidateIf((dto: CreateAccountDto) => dto.providerId === undefined)
  @IsString()
  @MaxLength(255)
  imapHost?: string;

  @ValidateIf((dto: CreateAccountDto) => dto.providerId === undefined)
  @IsInt()
  @Min(1)
  @Max(65535)
  imapPort?: number;

  @ValidateIf((dto: CreateAccountDto) => dto.providerId === undefined)
  @IsBoolean()
  imapSecure?: boolean;

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
