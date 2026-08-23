import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// A propósito sin campo "slug": es inmutable tras la creación (skill tenancy, regla 11).
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

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
