import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AppConfigService) {
    // La app en runtime SIEMPRE conecta con el rol sin privilegios elevados
    // (APP_DATABASE_URL), nunca con DATABASE_URL (dueño/superusuario que corre
    // las migraciones) — ver skill tenancy regla 8 y el comentario en la
    // migración multi_tenancy sobre por qué RLS no protege contra superusuarios.
    super({ datasourceUrl: config.appDatabaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Fija el tenant activo para la transacción vía SET LOCAL (skill tenancy). */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
