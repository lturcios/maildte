import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  async hash(plainText: string): Promise<string> {
    return argon2.hash(plainText, { type: argon2.argon2id });
  }

  async verify(hash: string, plainText: string): Promise<boolean> {
    return argon2.verify(hash, plainText);
  }
}
