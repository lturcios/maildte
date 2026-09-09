import { IsOptional, IsUUID } from 'class-validator';
import { PurchaseDocumentFiltersDto } from './purchase-document-filters.dto';

export {
  CLASSIFICATION_FILTERS,
  DATE_ONLY_PATTERN,
  MONTH_PATTERN,
} from './purchase-document-filters.dto';
export type { ClassificationFilter } from './purchase-document-filters.dto';

/**
 * Filtros del listado del libro de compras (Addendum 10, §7).
 *
 * Solo agrega `receptorId` opcional sobre `PurchaseDocumentFiltersDto`: en la
 * pantalla, "todos los receptores" es un filtro legítimo. La obligatoriedad se
 * declara en cada subclase y no en la base, porque un `@IsOptional()` heredado
 * no se puede cancelar en class-validator.
 */
export class ListPurchaseDocumentsDto extends PurchaseDocumentFiltersDto {
  @IsOptional()
  @IsUUID()
  receptorId?: string;
}
