import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { RedisModule } from './redis/redis.module';

/**
 * Infraestructura compartida entre el proceso API (AppModule) y el proceso
 * worker (WorkerModule): config validada, logger pino, Prisma, cifrado y
 * la conexión Redis para locks/contadores. Ninguno de los dos procesos debe
 * duplicar esta configuración.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,
          autoLogging: true,
          redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
        },
      }),
    }),
    PrismaModule,
    CryptoModule,
    RedisModule,
  ],
  exports: [ConfigModule, PrismaModule, CryptoModule, RedisModule],
})
export class CoreModule {}
