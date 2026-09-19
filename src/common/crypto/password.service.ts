import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import * as argon2 from 'argon2';

/**
 * Prefijo PHC de un hash argon2. Solo identifica el algoritmo: ni la sal ni el
 * digest entran acá, así que es seguro loggearlo.
 */
const ARGON2_PHC_PREFIX = /^\$argon2(id|i|d)\$/;

@Injectable()
export class PasswordService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(PasswordService.name);
  }

  async hash(plainText: string): Promise<string> {
    return argon2.hash(plainText, { type: argon2.argon2id });
  }

  /**
   * Compara una contraseña contra un hash almacenado.
   *
   * **Un hash ilegible devuelve `false`, no una excepción.** `argon2.verify()`
   * LANZA cuando el hash no es una cadena PHC válida, en vez de devolver
   * `false`; propagarlo convierte una fila corrupta en un **500 del endpoint
   * público de login**. Eso es malo por dos motivos: una sola fila dañada —un
   * restore parcial, una migración a medias, un `UPDATE` mal escapado— rompe
   * el login con un error de servidor en lugar de rechazarlo limpio, y un 500
   * distingue a ese usuario de los demás, que responden 401. Un atacante no
   * tiene por qué saber que una cuenta existe y además está rota.
   *
   * No es silenciar una excepción (anti-patrón de CLAUDE.md): se loggea en
   * ERROR y se decide. El log es la alarma, y lleva el contexto que quien
   * opera necesita para encontrar la fila.
   *
   * **Nunca se loggea el hash ni la contraseña.** Solo el prefijo PHC, que es
   * el identificador del algoritmo y es justo el dato que falta cuando el
   * valor almacenado no es un hash.
   *
   * @param context datos del llamador para el log (por ejemplo `{ userId }`).
   *   Sin esto el ERROR dice que algo está roto pero no qué fila.
   */
  async verify(
    hash: string,
    plainText: string,
    context: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!ARGON2_PHC_PREFIX.test(hash)) {
      this.logger.error(
        { ...context, hashPrefix: hash.slice(0, 10), hashLength: hash.length },
        'El hash almacenado no es una cadena argon2: la credencial se rechaza y la fila necesita revisión',
      );
      return false;
    }

    try {
      return await argon2.verify(hash, plainText);
    } catch (err: unknown) {
      // Llega acá un hash con prefijo válido pero cuerpo dañado, o un fallo
      // operativo de argon2 (el binding nativo, memoria). Los dos son ERROR y
      // los dos rechazan la credencial: no hay forma honesta de distinguirlos
      // sin leer el mensaje de la librería, y equivocarse hacia "aceptar" no
      // es una opción.
      this.logger.error(
        {
          ...context,
          hashPrefix: hash.slice(0, 10),
          err: err instanceof Error ? err.message : String(err),
        },
        'argon2 no pudo verificar la credencial',
      );
      return false;
    }
  }
}
