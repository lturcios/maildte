import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Catálogo de actividades de UN contribuyente (Addendum 11, fase 3).
 *
 * `receptorId` es obligatorio y se declara acá directamente, sin heredarlo de
 * ninguna base con `@IsOptional()`: el catálogo pertenece a un solo
 * contribuyente y un listado "de todos" mezclaría las unidades de negocio de
 * una empresa con las de otra. Es la misma razón de la regla 31 de CLAUDE.md,
 * y el mismo motivo por el que `PurchaseDocumentFiltersDto` no declara
 * validadores sobre `receptorId`.
 */
export class ListPurchaseActivitiesDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

  /** Búsqueda por nombre o código, para catálogos largos. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Por defecto solo las activas: las desactivadas son historia, no opciones. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 200;
}
