import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  CLASIFICACION_CODES,
  SECTOR_CODES,
  TIPO_COSTO_GASTO_CODES,
  TIPO_OPERACION_CODES,
} from '../anexo/classification-catalogs';
import { ACTIVITY_NAME_MAX_LENGTH, COD_ACTIVIDAD_PATTERN } from './create-purchase-activity.dto';

/** Topes del lote de siembra. Ver `PurchaseActivitySeedService`. */
export const SEED_MAX_ACTIVITIES = 200;
export const SEED_MAX_MAPPINGS = 1000;

/**
 * Propuesta de siembra (Addendum 11, fase 3). Solo lectura: deriva actividades
 * y mapeos de los `receptorCodActividad` que traen los DTE de ese receptor y no
 * escribe nada. El contador revisa, fusiona y descarta antes de aplicar.
 */
export class ProposeActivitySeedDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;
}

/** Una actividad de la propuesta, ya revisada por el contador. */
export class ApplyActivitySeedActivityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(ACTIVITY_NAME_MAX_LENGTH)
  nombre!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(COD_ACTIVIDAD_PATTERN, { message: 'codActividad debe ser un código numérico' })
  codActividad?: string | null;

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

/**
 * Un mapeo de la propuesta. La actividad se referencia POR NOMBRE y no por id
 * porque en el mismo lote puede no existir todavía: el nombre es la clave
 * natural del catálogo (`@@unique([tenantId, receptorId, nombre])`).
 */
export class ApplyActivitySeedMappingDto {
  @IsUUID(undefined, { message: 'emisorId debe ser un UUID válido' })
  emisorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(ACTIVITY_NAME_MAX_LENGTH)
  activityNombre!: string;
}

/**
 * Aplicación de la siembra ya revisada.
 *
 * `confirm` es el flag explícito que exige CLAUDE.md para una escritura masiva
 * desde código de aplicación: la propuesta se pide por separado, se revisa, y
 * recién entonces se confirma. Sin `confirm: true` no se escribe nada.
 */
export class ApplyActivitySeedDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

  @Equals(true, {
    message: 'confirm debe ser true: la siembra escribe el catálogo y el mapeo del contribuyente',
  })
  confirm!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SEED_MAX_ACTIVITIES)
  @ValidateNested({ each: true })
  @Type(() => ApplyActivitySeedActivityDto)
  activities!: ApplyActivitySeedActivityDto[];

  @IsArray()
  @ArrayMaxSize(SEED_MAX_MAPPINGS)
  @ValidateNested({ each: true })
  @Type(() => ApplyActivitySeedMappingDto)
  mappings!: ApplyActivitySeedMappingDto[];
}
