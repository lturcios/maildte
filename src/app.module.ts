import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CoreModule } from './core.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/guards/auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AccountsModule } from './accounts/accounts.module';
import { SyncBootstrapModule } from './sync/sync-bootstrap.module';
import { EmailsModule } from './emails/emails.module';
import { StatsModule } from './stats/stats.module';
import { ExportModule } from './export/export.module';
import { PurchaseBookModule } from './purchase-book/purchase-book.module';
import { UsersModule } from './users/users.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AdminModule } from './admin/admin.module';
import { MailProvidersModule } from './mail-providers/mail-providers.module';

@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    HealthModule,
    AuthModule,
    AccountsModule,
    SyncBootstrapModule,
    EmailsModule,
    StatsModule,
    ExportModule,
    PurchaseBookModule,
    UsersModule,
    ApiKeysModule,
    AdminModule,
    MailProvidersModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
