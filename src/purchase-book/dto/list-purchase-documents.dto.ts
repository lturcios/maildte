import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Filtro por estado de clasificación Q–T. */
export const CLASSIFICATION_FILTERS = ['all', 'classified', 'unclassified'] as const;
export type ClassificationFilter = (typeof CLASSIFICATION_FILTERS)[number];

/** `YYYY-MM-DD`, lo que envía un `<input type="date">`. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `YYYY-MM`, atajo de período fiscal. */
export const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Filtros del listado del libro de compras (Addendum 10, §7).
 *
 * El eje de fecha es `fecEmi`, la fecha de emisión del DTE, que es la que usa
 * el período fiscal. NO es `receivedAt` (cuándo llegó el correo) ni
 * `createdAt` (cuándo se archivó): son tres ejes distintos y el contador
 * declara por el primero.
 */
export class ListPurchaseDocumentsDto {
  @IsOptional()
  @IsUUID()
  emisorId?: string;

  @IsOptional()
  @IsUUID()
  receptorId?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'from debe tener formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'to debe tener formato YYYY-MM-DD' })
  to?: string;

  /** Atajo de período. Si viene, tiene precedencia sobre `from`/`to`. */
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month debe tener formato YYYY-MM' })
  month?: string;

  /** Búsqueda libre sobre número de control, código de generación y proveedor. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @IsIn(CLASSIFICATION_FILTERS)
  classification?: ClassificationFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}
