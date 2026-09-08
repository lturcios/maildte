import { IsIn, IsInt, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import {
  CLASIFICACION_CODES,
  SECTOR_CODES,
  TIPO_COSTO_GASTO_CODES,
  TIPO_OPERACION_CODES,
} from '../anexo/classification-catalogs';

/**
 * Override de las columnas Q–T de un documento (Addendum 10, §7).
 *
 * `null` explícito NO es "sin cambio": significa "limpiar el override y volver
 * al default del receptor". Por eso cada campo usa `@ValidateIf` para saltear
 * la validación de rango solo cuando el valor es `null`, en vez de `@IsOptional`,
 * que también saltearía el `null` sin distinguirlo de la ausencia.
 */
export class UpdateClassificationDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(TIPO_OPERACION_CODES, { message: 'anexoTipoOperacion fuera del catálogo' })
  anexoTipoOperacion?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(CLASIFICACION_CODES, { message: 'anexoClasificacion fuera del catálogo' })
  anexoClasificacion?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(SECTOR_CODES, { message: 'anexoSector fuera del catálogo' })
  anexoSector?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @IsIn(TIPO_COSTO_GASTO_CODES, { message: 'anexoTipoCostoGasto fuera del catálogo' })
  anexoTipoCostoGasto?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  anexoNota?: string | null;
}
