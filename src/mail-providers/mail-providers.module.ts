import { Module } from '@nestjs/common';
import { MailProvidersService } from './mail-providers.service';
import { MailProvidersController } from './mail-providers.controller';
import { AdminMailProvidersController } from './admin-mail-providers.controller';

@Module({
  controllers: [MailProvidersController, AdminMailProvidersController],
  providers: [MailProvidersService],
  exports: [MailProvidersService],
})
export class MailProvidersModule {}
