import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { DATE_ONLY_PATTERN, MONTH_PATTERN } from './list-purchase-documents.dto';

/**
 * Modos del backfill (Addendum 10, §6.6):
 * - `missing`: adjuntos JSON sin fila en el ledger. Es el caso normal tras un
 *   despliegue o después de que Redis estuviera caído.
 * - `failed`: además los estados de error y las filas parseadas con una
 *   versión anterior del parser.
 * - `all`: re-parsea todo el filtro con `force`, preservando los overrides Q–T.
 */
export const REPROCESS_MODES = ['missing', 'failed', 'all'] as const;
export type ReprocessMode = (typeof REPROCESS_MODES)[number];

export class ReprocessDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Filtra por la carpeta mensual del correo (`ProcessedEmail.monthFolder`). */
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month debe tener formato YYYY-MM' })
  month?: string;

  /** Rango sobre la fecha de recepción del correo, no sobre la de emisión. */
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'from debe tener formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'to debe tener formato YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @IsIn(REPROCESS_MODES)
  mode: ReprocessMode = 'missing';

  /** Id del último adjunto encolado en la llamada anterior. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
