import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { TenantAssignableRole } from './create-user.dto';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsIn([Role.ADMIN, Role.MIEMBRO])
  role?: TenantAssignableRole;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
