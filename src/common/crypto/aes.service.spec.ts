import { AesService } from './aes.service';
import { AppConfigService } from '../../config/app-config.service';

function buildService(encryptionKey: string): AesService {
  const configMock = { encryptionKey } as AppConfigService;
  return new AesService(configMock);
}

describe('AesService', () => {
  const validKey = 'a'.repeat(64); // 32 bytes en hex

  it('cifra y descifra el mismo texto plano (roundtrip)', () => {
    const service = buildService(validKey);
    const plainText = 'super-secreto-imap-2026';

    const encrypted = service.encrypt(plainText);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted).toBe(plainText);
  });

  it('almacena el payload cifrado en formato iv:tag:cipher en base64', () => {
    const service = buildService(validKey);

    const encrypted = service.encrypt('valor');
    const parts = encrypted.split(':');

    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
    }
  });

  it('lanza si el authTag fue alterado (integridad GCM)', () => {
    const service = buildService(validKey);
    const encrypted = service.encrypt('valor-sensible');
    const [iv, tag, cipher] = encrypted.split(':');

    const tamperedTag = Buffer.from(tag, 'base64');
    tamperedTag[0] = tamperedTag[0] ^ 0xff;
    const tampered = `${iv}:${tamperedTag.toString('base64')}:${cipher}`;

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('lanza al construirse si ENCRYPTION_KEY no representa 32 bytes', () => {
    expect(() => buildService('deadbeef')).toThrow(
      'ENCRYPTION_KEY debe representar exactamente 32 bytes en hex',
    );
  });
});
