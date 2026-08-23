import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

export type TenantAssignableRole = Exclude<Role, 'SUPERADMIN'>;

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  // No se admite SUPERADMIN acá: eso sale exclusivamente de /admin (onboarding de tenant).
  @IsOptional()
  @IsIn([Role.ADMIN, Role.MIEMBRO])
  role?: TenantAssignableRole;
}
