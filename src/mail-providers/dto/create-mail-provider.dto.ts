import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MailProviderDomainDto } from './mail-provider-domain.dto';

export class CreateMailProviderDto {
  /**
   * Identificador estable del perfil. Inmutable tras la creación, igual que el
   * slug de un tenant: scripts/seed-mail-providers.ts hace upsert por esta
   * clave, y renombrarla haría que la semilla cree un perfil duplicado.
   */
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'key debe contener solo minúsculas, números y guiones' })
  @MaxLength(60)
  key!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(255)
  imapHost!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  imapPort!: number;

  @IsBoolean()
  imapSecure!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  defaultMailbox?: string;

  /** Dominio obvio: el frontend advierte si el usuario cambia el perfil detectado. */
  @IsOptional()
  @IsBoolean()
  strict?: boolean;

  /** Requisitos de autenticación en lenguaje del usuario final. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  helpUrl?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MailProviderDomainDto)
  domains?: MailProviderDomainDto[];
}
