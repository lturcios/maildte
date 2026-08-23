import { Module } from '@nestjs/common';
import { ImapClientFactory } from './imap-client.factory';

@Module({
  providers: [ImapClientFactory],
  exports: [ImapClientFactory],
})
export class ImapModule {}
