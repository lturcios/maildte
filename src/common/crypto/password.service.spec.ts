import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { PasswordService } from './password.service';

const loggerMock = { setContext: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() };

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [PasswordService, { provide: PinoLogger, useValue: loggerMock }],
    }).compile();
    service = moduleRef.get(PasswordService);
  });

  describe('hash y verify', () => {
    it('acepta la contraseña correcta', async () => {
      const hash = await service.hash('clave-correcta');
      await expect(service.verify(hash, 'clave-correcta')).resolves.toBe(true);
    });

    it('rechaza la contraseña equivocada sin loggear un error', async () => {
      const hash = await service.hash('clave-correcta');

      await expect(service.verify(hash, 'otra-clave')).resolves.toBe(false);
      // Una contraseña equivocada es el caso NORMAL de un login: no es un
      // problema de datos y no puede ensuciar el log de errores.
      expect(loggerMock.error).not.toHaveBeenCalled();
    });

    it('produce argon2id', async () => {
      expect(await service.hash('x')).toMatch(/^\$argon2id\$/);
    });
  });

  /**
   * El caso que motivó esta guarda: un hash pegado entre comillas dobles en un
   * shell pierde todo lo que va detrás de cada `$`. Antes, `argon2.verify()`
   * lanzaba y el endpoint público de login devolvía 500.
   */
  describe('hash almacenado ilegible', () => {
    const MANGLED = '=19=65536,t=3,p=4/usr/bin/bash123456789ABCDEF';

    it('devuelve false en vez de propagar la excepción', async () => {
      await expect(service.verify(MANGLED, 'la-que-sea')).resolves.toBe(false);
    });

    it('lo registra en ERROR: es un problema de datos, no una credencial mala', async () => {
      await service.verify(MANGLED, 'la-que-sea', { userId: 'user-1' });

      expect(loggerMock.error).toHaveBeenCalledTimes(1);
      const [payload] = loggerMock.error.mock.calls[0] as [Record<string, unknown>];
      expect(payload.userId).toBe('user-1');
    });

    it('nunca loggea el hash completo ni la contraseña', async () => {
      await service.verify(MANGLED, 'secreto-del-usuario', { userId: 'user-1' });

      const serializado = JSON.stringify(loggerMock.error.mock.calls[0]);
      expect(serializado).not.toContain('secreto-del-usuario');
      expect(serializado).not.toContain(MANGLED);
    });

    it('una cadena vacía tampoco rompe', async () => {
      await expect(service.verify('', 'la-que-sea')).resolves.toBe(false);
    });

    it('un hash de otro algoritmo se rechaza sin llamar a argon2', async () => {
      // bcrypt, por ejemplo: un resto de una migración vieja no puede ser un
      // 500 en el login.
      await expect(service.verify('$2b$10$abcdefghijklmnopqrstuv', 'la-que-sea')).resolves.toBe(
        false,
      );
      expect(loggerMock.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('hash con prefijo válido pero cuerpo dañado', () => {
    it('devuelve false y lo registra, en vez de 500', async () => {
      // Pasa la guarda de prefijo y explota dentro de argon2: es el otro
      // camino, y tiene que terminar igual.
      await expect(service.verify('$argon2id$v=19$roto', 'la-que-sea')).resolves.toBe(false);
      expect(loggerMock.error).toHaveBeenCalledTimes(1);
    });
  });
});
