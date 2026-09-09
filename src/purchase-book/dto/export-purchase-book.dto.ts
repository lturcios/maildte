import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PurchaseDocumentFiltersDto } from './purchase-document-filters.dto';

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Export del Anexo 3 (Addendum 10, §8). Comparte con el listado los filtros de
 * `PurchaseDocumentFiltersDto`, para que lo exportado sea exactamente lo que el
 * usuario ve en pantalla.
 *
 * Extiende la base y no `ListPurchaseDocumentsDto` precisamente para no heredar
 * el `@IsOptional()` del `receptorId` del listado, que dejaría inerte la
 * validación obligatoria de más abajo.
 *
 * `page` y `limit` se heredan pero NO se usan: el export recorre el filtro
 * completo por cursor, acotado por PURCHASE_BOOK_EXPORT_MAX_ROWS.
 */
export class ExportPurchaseBookDto extends PurchaseDocumentFiltersDto {
  /**
   * Obligatorio, a diferencia del listado, donde es opcional.
   *
   * El Anexo 3 se presenta POR CONTRIBUYENTE: el archivo declara las compras de
   * una sola empresa. Un mismo buzón recibe DTE a favor de varios receptores, y
   * exportar "todos" mezclaría en la declaración de una empresa las compras de
   * otra. Por eso el filtro de receptor no es una comodidad de la pantalla sino
   * una condición de validez fiscal del archivo.
   *
   * El `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`) responde
   * 400 cuando el parámetro falta, que es el comportamiento esperado en la capa
   * de DTO. `ExportPurchaseBookService.collectRows` vuelve a exigirlo con un 422
   * y además verifica que el conjunto exportado tenga un solo receptor.
   */
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

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
