import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
import { ACTIVITY_NAME_MAX_LENGTH, COD_ACTIVIDAD_PATTERN } from './create-purchase-activity.dto';

/**
 * Modificación de una actividad del catálogo (Addendum 11, fase 3).
 *
 * PATCH parcial: solo se escriben las claves presentes en el body. Un `null`
 * explícito en `codActividad` o en un default Q–T lo limpia; su ausencia lo
 * deja intacto (mismo criterio que `UpdatePartyDefaultsDto`).
 *
 * `receptorId` NO se puede cambiar: mover una actividad de contribuyente
 * arrastraría el mapeo de proveedores y los overrides de documentos de otra
 * empresa. Si el catálogo quedó en el receptor equivocado, se desactiva y se
 * crea de nuevo donde corresponde.
 */
export class UpdatePurchaseActivityDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ACTIVITY_NAME_MAX_LENGTH)
  nombre?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(COD_ACTIVIDAD_PATTERN, { message: 'codActividad debe ser un código numérico' })
  codActividad?: string | null;

  /**
   * Retiro y reactivación de la actividad. En inglés, igual que en el esquema:
   * regla 23 de CLAUDE.md, y el mismo nombre que ya usan `Tenant.active` y
   * `MailProvider.active`. Es la contraparte de `includeInactive` del listado.
   */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

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
