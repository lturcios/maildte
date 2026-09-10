import { IsUUID } from 'class-validator';

/**
 * Mapeo (proveedor, receptor) -> actividad (Addendum 11, §7.4).
 *
 * Los tres DTO declaran `receptorId` obligatorio por separado y ninguno hereda
 * una base con `@IsOptional()`: el default es POR RECEPTOR, y un mapeo sin
 * receptor sería un criterio global al tenant que aplicaría la decisión de un
 * contribuyente a las compras de otro (mismo error de forma que la regla 31 de
 * CLAUDE.md).
 */
export class ListSupplierActivityDefaultsDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;
}

export class SetSupplierActivityDefaultDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

  @IsUUID(undefined, { message: 'emisorId debe ser un UUID válido' })
  emisorId!: string;

  /**
   * La actividad tiene que pertenecer al MISMO tenant y al MISMO receptor. El
   * servicio lo verifica antes de escribir: un mapeo apuntando a la actividad
   * de otro contribuyente es exactamente la fuga que este diseño existe para
   * impedir.
   */
  @IsUUID(undefined, { message: 'activityId debe ser un UUID válido' })
  activityId!: string;
}

export class ClearSupplierActivityDefaultDto {
  @IsUUID(undefined, { message: 'receptorId debe ser un UUID válido' })
  receptorId!: string;

  @IsUUID(undefined, { message: 'emisorId debe ser un UUID válido' })
  emisorId!: string;
}
