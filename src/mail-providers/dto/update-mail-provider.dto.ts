import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MailProviderDomainDto } from './mail-provider-domain.dto';

/** Sin `key`: es inmutable tras la creación (ver CreateMailProviderDto). */
export class UpdateMailProviderDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

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
  defaultMailbox?: string;

  @IsOptional()
  @IsBoolean()
  strict?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  helpUrl?: string;

  /** false oculta el perfil del alta de cuentas sin desvincular las existentes. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  /** Si viene, REEMPLAZA la lista completa de dominios. Si se omite, no se toca. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MailProviderDomainDto)
  domains?: MailProviderDomainDto[];

  /**
   * Confirmación obligatoria para cambiar imapHost/imapPort/imapSecure de un
   * perfil que ya usan cuentas (ADR-09.1). Como el vínculo es una referencia
   * viva, ese cambio se aplica en caliente a todos los tenants en la siguiente
   * ronda de sincronización: hay que escribir el número exacto de cuentas
   * afectadas, igual que GitHub pide el nombre del repo para borrarlo.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  confirmAffectedAccounts?: number;
}
