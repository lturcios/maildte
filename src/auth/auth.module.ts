import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({
  imports: [JwtModule.register({})], // secreto y expiración se pasan explícitos en cada sign/verify
  controllers: [AuthController, MeController],
  providers: [AuthService, AuthGuard, RolesGuard],
  exports: [JwtModule, AuthService, AuthGuard, RolesGuard],
})
export class AuthModule {}
