import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CONNECTION } from './redis.constants';

/**
 * Cierra la conexión compartida al apagar el módulo. Sin esto, un `app.close()`
 * (tests e2e, shutdown graceful) deja el socket de ioredis abierto y el proceso
 * nunca termina solo (Jest queda colgado esperando que el event loop drene).
 */
@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => new Redis(config.redisUrl),
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CONNECTION],
})
export class RedisModule {}
