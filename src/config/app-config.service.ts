import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): string {
    return this.config.getOrThrow<string>('NODE_ENV');
  }

  get port(): number {
    return this.config.getOrThrow<number>('PORT');
  }

  get databaseUrl(): string {
    return this.config.getOrThrow<string>('DATABASE_URL');
  }

  get appDatabaseUrl(): string {
    return this.config.getOrThrow<string>('APP_DATABASE_URL');
  }

  get redisUrl(): string {
    return this.config.getOrThrow<string>('REDIS_URL');
  }

  get encryptionKey(): string {
    return this.config.getOrThrow<string>('ENCRYPTION_KEY');
  }

  get jwtSecret(): string {
    return this.config.getOrThrow<string>('JWT_SECRET');
  }

  get jwtRefreshSecret(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  get storageRoot(): string {
    return this.config.getOrThrow<string>('STORAGE_ROOT');
  }

  get defaultSyncInterval(): number {
    return this.config.getOrThrow<number>('DEFAULT_SYNC_INTERVAL');
  }

  get tzFolder(): string {
    return this.config.getOrThrow<string>('TZ_FOLDER');
  }

  get logLevel(): string {
    return this.config.getOrThrow<string>('LOG_LEVEL');
  }

  get maxAttachmentMb(): number {
    return this.config.getOrThrow<number>('MAX_ATTACHMENT_MB');
  }

  get exportMaxZipFiles(): number {
    return this.config.getOrThrow<number>('EXPORT_MAX_ZIP_FILES');
  }

  get corsOrigins(): string[] {
    return this.config
      .getOrThrow<string>('CORS_ORIGIN')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }
}
