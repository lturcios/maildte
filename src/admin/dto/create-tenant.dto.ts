import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  // Inmutable tras la creación (skill tenancy, regla 11): las rutas de storage persistidas
  // dependen de este valor y nunca se recalculan.
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug debe contener solo minúsculas, números y guiones' })
  @MaxLength(60)
  slug!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxAccounts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStorageBytes?: number;
}
