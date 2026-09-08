import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ListPurchaseDocumentsDto } from './list-purchase-documents.dto';

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Export del Anexo 3 (Addendum 10, §8). Hereda todos los filtros del listado
 * para que lo exportado sea exactamente lo que el usuario ve en pantalla.
 *
 * `page` y `limit` se heredan pero NO se usan: el export recorre el filtro
 * completo por cursor, acotado por PURCHASE_BOOK_EXPORT_MAX_ROWS.
 */
export class ExportPurchaseBookDto extends ListPurchaseDocumentsDto {
  @IsIn(EXPORT_FORMATS, { message: 'format debe ser csv o xlsx' })
  format!: ExportFormat;

  /** Fila de encabezado legible. Solo XLSX: Hacienda no la acepta en el CSV. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  header?: boolean;

  /**
   * Permite exportar con las columnas Q–T vacías. Sin esto, un filtro con
   * documentos sin clasificar se rechaza con 422 en vez de generar un archivo
   * que Hacienda va a rebotar.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  allowUnclassified?: boolean;
}
