import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContext } from '../common/tenancy/tenant-context';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const data = await this.auth.login(dto.email, dto.password);
    return { data };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const data = await this.auth.refresh(dto.refreshToken);
    return { data };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentTenant() ctx: TenantContext): Promise<void> {
    await this.auth.logout(ctx.actor.type, ctx.actor.id);
  }
}
