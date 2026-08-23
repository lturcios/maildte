import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok' | 'error';
  database: 'up' | 'down';
  redis: 'up' | 'down';
}

@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private redis!: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.redis = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  async check(): Promise<HealthStatus> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      database,
      redis,
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      if (this.redis.status === 'end' || this.redis.status === 'wait') {
        await this.redis.connect();
      }
      const reply = await this.redis.ping();
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
