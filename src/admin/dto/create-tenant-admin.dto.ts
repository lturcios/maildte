import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTenantAdminDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
