import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Override de la actividad económica de un documento (Addendum 11, §7.4).
 *
 * `activityId` es obligatorio y `null` es un valor legítimo: significa "quitá
 * el override y volvé al default del proveedor", no "no cambies nada". Por eso
 * `@ValidateIf` en vez de `@IsOptional()`, que saltearía el `null` sin poder
 * distinguirlo de la ausencia de la clave — misma decisión que en
 * `UpdateClassificationDto`.
 *
 * A diferencia de aquel, acá NO hay PATCH parcial que proteger: el body tiene
 * un solo campo, así que omitirlo no es "no tocar la actividad", es una
 * petición sin contenido. Se rechaza.
 */
export class UpdateDocumentActivityDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4', {
    message:
      'activityId debe ser el UUID de una actividad del catálogo, o null para quitar el override',
  })
  activityId!: string | null;
}
