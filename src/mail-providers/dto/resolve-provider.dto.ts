import { IsEmail, MaxLength } from 'class-validator';

export class ResolveProviderDto {
  /**
   * Dirección completa, no solo el dominio: el frontend la tiene a mano y así el
   * contrato queda igual que el del alta de cuenta.
   */
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
