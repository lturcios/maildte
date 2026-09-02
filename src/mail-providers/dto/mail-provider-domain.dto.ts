import { DomainMatchKind } from '@prisma/client';
import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';

/** Etiqueta de dominio: sin protocolo, sin punto final, al menos dos niveles. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export class MailProviderDomainDto {
  @IsString()
  @MaxLength(255)
  @Matches(DOMAIN_PATTERN, {
    message: 'domain debe ser un dominio válido en minúsculas, por ejemplo gmail.com',
  })
  domain!: string;

  /**
   * DOMAIN: coincide con el dominio del correo (gmail.com).
   * MX_SUFFIX: coincide con el sufijo del registro MX del dominio del cliente
   * (google.com), para detectar Workspace/M365 detrás de un dominio propio.
   */
  @IsEnum(DomainMatchKind)
  kind!: DomainMatchKind;
}
