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
 * UUID v4 o el literal `none`.
 *
 * Un solo `@Matches` y no `@IsUUID()` mas una excepcion: class-validator
 * encadena los decoradores con AND, asi que `@IsUUID()` rechazaria `none`
 * antes de que nadie pudiera contemplarlo.
 */
export const ACTIVITY_FILTER_PATTERN =
  /^(none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * Filtros comunes del libro de compras (Addendum 10, §7): los comparten el
 * listado y el export del Anexo 3, para que lo exportado sea exactamente lo que
 * el usuario ve en pantalla.
 *
 * El eje de fecha es `fecEmi`, la fecha de emisión del DTE, que es la que usa
 * el período fiscal. NO es `receivedAt` (cuándo llegó el correo) ni
 * `createdAt` (cuándo se archivó): son tres ejes distintos y el contador
 * declara por el primero.
 */
export class PurchaseDocumentFiltersDto {
  /**
   * Declarada acá SIN decorador de validación a propósito.
   *
   * Cada subclase define su propia obligatoriedad: opcional en el listado,
   * obligatoria en el export del Anexo 3. Un `@IsOptional()` en la base se
   * heredaría hacia el export, y class-validator no permite cancelar un
   * `@IsOptional()` heredado: lo registra como metadato condicional de la
   * propiedad y lo sigue aplicando en la subclase, cortocircuitando en silencio
   * cualquier validador que la subclase declare sobre `receptorId`.
   *
   * Eso es exactamente el bug que se corrigió: el export aceptaba peticiones sin
   * receptor y generaba un Anexo 3 fiscalmente inválido sin ningún error. No
   * mover un decorador de validación hasta acá.
   */
  receptorId?: string;

  @IsOptional()
  @IsUUID()
  emisorId?: string;

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

  /**
   * Filtro por actividad economica (Addendum 11, fase 3).
   *
   * Acepta el id de una actividad del catalogo o el literal `none`, que pide
   * las compras sin actividad resuelta — el trabajo que queda pendiente
   * despues de sembrar el mapeo, y por eso el filtro mas usado de la pantalla.
   *
   * NO se traduce a `where activityId = X`: la actividad efectiva es un valor
   * derivado (override del documento > default del proveedor), y el predicado
   * lo arma `buildActivityFilter()` contra la base.
   */
  @IsOptional()
  @Matches(ACTIVITY_FILTER_PATTERN, {
    message: 'activityId debe ser un UUID o el literal none',
  })
  activityId?: string;

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
