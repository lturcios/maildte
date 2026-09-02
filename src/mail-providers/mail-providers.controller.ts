import { Controller, Get, Query } from '@nestjs/common';
import { MailProvidersService } from './mail-providers.service';
import { ResolveProviderDto } from './dto/resolve-provider.dto';

/**
 * Catálogo de servicios de correo para el alta de cuentas. Sin @Roles: lo
 * consulta cualquier usuario autenticado, de cualquier tenant, porque el
 * catálogo es global y de solo lectura desde acá. La escritura vive en
 * AdminMailProvidersController, restringida a SUPERADMIN.
 */
@Controller('mail-providers')
export class MailProvidersController {
  constructor(private readonly providers: MailProvidersService) {}

  @Get()
  async findAll() {
    const data = await this.providers.findAllActive();
    return { data };
  }

  /**
   * Sugiere el perfil para una dirección de correo (ADR-09.3).
   *
   * Dispara una consulta DNS a partir de un dominio que elige el usuario, así
   * que depende del ThrottlerGuard global y de la caché en Redis para no
   * convertirse en un amplificador. Además exige autenticación como el resto
   * del controller.
   */
  @Get('resolve')
  async resolve(@Query() query: ResolveProviderDto) {
    const data = await this.providers.resolveByEmail(query.email);
    return { data };
  }
}
