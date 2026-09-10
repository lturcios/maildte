import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  CLASIFICACION_CODES,
  SECTOR_CODES,
  TIPO_COSTO_GASTO_CODES,
  TIPO_OPERACION_CODES,
} from '../anexo/classification-catalogs';

/**
 * Código CIIU tal como lo emite Hacienda en el DTE: solo dígitos.
 *
 * No se valida contra un catálogo cerrado a propósito: el código acá es una
 * pista para prellenar el mapeo, no una identidad, y rechazar un código válido
 * que el catálogo local no conoce dejaría al contador sin poder registrar su
 * propia actividad.
 */
export const COD_ACTIVIDAD_PATTERN = /^\d{2,10}$/;

/** Nombre visible de la actividad. Es la identidad, así que tiene tope. */
export const ACTIVITY_NAME_MAX_LENGTH = 120;

/**
 * Alta de una actividad del catálogo de un contribuyente (Addendum 11, fase 3).
 *
 * `receptorId` obligatorio y declarado acá directamente: el catálogo pertenece
 * a un solo contribuyente (regla 31 de CLAUDE.md).
 */
export class CreatePurchaseActivityDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(ACTIVITY_NAME_MAX_LENGTH)
  nombre!: string;

  /**
   * Opcional y NO único: dos locales del mismo rubro comparten código CIIU y
   * son dos unidades de negocio distintas. `null` explícito limpia el código.
   */
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
