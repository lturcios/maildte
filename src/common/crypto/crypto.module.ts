import { Global, Module } from '@nestjs/common';
import { AesService } from './aes.service';
import { PasswordService } from './password.service';

@Global()
@Module({
  providers: [AesService, PasswordService],
  exports: [AesService, PasswordService],
})
export class CryptoModule {}
