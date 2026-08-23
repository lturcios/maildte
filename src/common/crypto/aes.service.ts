import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

@Injectable()
export class AesService {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    this.key = Buffer.from(config.encryptionKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY debe representar exactamente 32 bytes en hex');
    }
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${cipherText.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, cipherB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !cipherB64) {
      throw new Error('Formato de payload cifrado inválido');
    }
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const cipherText = Buffer.from(cipherB64, 'base64');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return plainText.toString('utf8');
  }
}
