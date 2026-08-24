import { IsISO8601 } from 'class-validator';

export class ResyncAccountDto {
  /** Nuevo punto de partida: la cuenta vuelve a recorrer el buzón desde esta fecha. */
  @IsISO8601()
  syncFromDate!: string;
}
