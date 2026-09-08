import { IsIn, IsInt, IsOptional, ValidateIf } from 'class-validator';
import {
  CLASIFICACION_CODES,
  SECTOR_CODES,
  TIPO_COSTO_GASTO_CODES,
  TIPO_OPERACION_CODES,
} from '../anexo/classification-catalogs';

/**
 * Defaults Q–T de un receptor (Addendum 10, ADR-10.5). Igual que el override
 * del documento, `null` limpia el default en vez de dejarlo sin cambio.
 */
export class UpdatePartyDefaultsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(TIPO_OPERACION_CODES, { message: 'defaultTipoOperacion fuera del catálogo' })
  defaultTipoOperacion?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(CLASIFICACION_CODES, { message: 'defaultClasificacion fuera del catálogo' })
  defaultClasificacion?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(SECTOR_CODES, { message: 'defaultSector fuera del catálogo' })
  defaultSector?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(TIPO_COSTO_GASTO_CODES, { message: 'defaultTipoCostoGasto fuera del catálogo' })
  defaultTipoCostoGasto?: number | null;
}
