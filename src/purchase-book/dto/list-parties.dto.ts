import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const PARTY_ROLES = ['EMISOR', 'RECEPTOR'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** Alimenta los selects de filtro del panel (Addendum 10, §7). */
export class ListPartiesDto {
  @IsIn(PARTY_ROLES, { message: 'role debe ser EMISOR o RECEPTOR' })
  role!: PartyRole;

  /** Búsqueda por nombre o identificador, para catálogos largos. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 200;
}
