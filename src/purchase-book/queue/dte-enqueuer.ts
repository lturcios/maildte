import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Queue } from 'bullmq';
import {
  DTE_PARSE_JOB_NAME,
  DTE_QUEUE,
  DteParseJobData,
  dteParseJobId,
  DteParseTrigger,
} from './dte-queue.constants';

/** Reintentos con backoff exponencial: los fallos de infraestructura se reintentan. */
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_MS = 30_000;

/**
 * Los fallos SÍ se retienen. Un job que reventó por infraestructura (Redis sin
 * memoria, disco ilegible, pool de Prisma agotado) puede no haber dejado fila en
 * `dte_parse_results`, así que el registro en Redis es la única evidencia que
 * queda para depurarlo. Es lo contrario de los completados: ahí el ledger en
 * Postgres ya tiene el resultado y el registro de Redis solo estorba.
 *
 * El precio de retenerlos es que un `jobId` fallido bloquea su propio
 * re-encolado — exactamente los adjuntos que `mode=failed` existe para
 * recuperar. Por eso el camino de reprocesamiento borra el registro previo antes
 * de encolar (`clearPreviousJobs`) en lugar de bajar la retención a 0.
 */
const KEEP_FAILED = 500;

export interface EnqueueParseTarget {
  tenantId: string;
  attachmentId: string;
}

/**
 * Encola trabajos de parseo de DTE (Addendum 10, §6.2).
 *
 * Vive en la API y en el worker: el sync encola tras persistir un correo y el
 * backfill encola lotes desde el endpoint de reprocesamiento.
 */
@Injectable()
export class DteEnqueuer {
  constructor(
    @Inject(DTE_QUEUE) private readonly queue: Queue<DteParseJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DteEnqueuer.name);
  }

  /**
   * Encola varios adjuntos de una sola llamada a Redis.
   *
   * No lanza: encolar es una optimización, no una garantía. Si Redis está
   * caído, el correo ya quedó archivado y el backfill (`mode=missing`) recupera
   * lo que no se encoló. Reventar acá marcaría como ERROR un correo que se
   * descargó bien.
   *
   * **Devuelve cuántos trabajos reportó `addBulk`, que NO es cuántos van a
   * ejecutarse.** La distinción no se puede cerrar desde acá: ante un `jobId`
   * que ya existe en Redis, el script Lua de BullMQ devuelve el job existente en
   * lugar de crear uno nuevo, y el cliente recibe la misma forma de respuesta
   * que ante una inserción real. No hay ningún campo que distinga un duplicado
   * absorbido de un trabajo nuevo, así que este número no puede prometerlo.
   *
   * Lo que el retorno SÍ significa, y por lo que TODO llamador está obligado a
   * compararlo contra `targets.length`: **un valor menor es un lote que se
   * perdió y nunca llegó a la cola.** No hacerlo es lo que dejó el libro de
   * compras vacío en silencio: un `jobId` con `:` hacía lanzar a `addBulk`, este
   * método se tragaba la excepción y devolvía 0, y nadie miraba el número (ver
   * `dteParseJobId`).
   *
   * La absorción de duplicados se ataca donde importa, no con el retorno: en el
   * camino de reprocesamiento se borra el registro de job previo antes de
   * encolar (`clearPreviousJobs`).
   */
  async enqueueParseBulk(
    targets: EnqueueParseTarget[],
    trigger: DteParseTrigger,
    force = false,
  ): Promise<number> {
    if (targets.length === 0) return 0;

    // Solo en el reprocesamiento. En el `sync`, que dos encolados del mismo
    // adjunto colapsen mientras el job sigue pendiente es el comportamiento
    // deseado: es la primera línea de idempotencia y ahorra trabajo repetido.
    if (trigger === 'reprocess') {
      await this.clearPreviousJobs(targets);
    }

    try {
      const jobs = await this.queue.addBulk(
        targets.map((target) => ({
          name: DTE_PARSE_JOB_NAME,
          data: { ...target, trigger, force },
          opts: {
            jobId: dteParseJobId(target.attachmentId),
            attempts: JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
            // Sin retención de completados, a propósito. El registro durable y
            // auditable del parseo es la tabla `dte_parse_results` en Postgres,
            // no el historial de jobs de Redis: cualquier pregunta sobre qué
            // pasó con un adjunto se responde con el ledger. Lo único que ese
            // historial aportaba era sabotear el re-encolado, porque el `jobId`
            // es determinístico y BullMQ ignora en silencio un `add` cuyo id ya
            // existe. Con `removeOnComplete: 500` el colapso duraba los
            // siguientes 500 jobs completados de TODA la instalación: el
            // backfill del Addendum 11 fase 1 (producción, 2026-09-09) reportó
            // 968 trabajos encolados y reprocesó 419 documentos de 862.
            removeOnComplete: true,
            removeOnFail: KEEP_FAILED,
          },
        })),
      );
      return jobs.length;
    } catch (err) {
      // ERROR y no WARN a propósito: un lote que nunca llega a la cola es una
      // falla, y el único aviso de que el libro de compras se está quedando
      // vacío. WARN no dispara alertas; nadie lo mira.
      this.logger.error(
        { err, count: targets.length, trigger, force },
        'No se pudo encolar el parseo de DTE; el lote se perdió y se recuperará con el reprocesamiento',
      );
      return 0;
    }
  }

  /**
   * Borra el registro de job previo de cada adjunto antes de re-encolarlo.
   *
   * Es lo que hace que el reprocesamiento reprocese. BullMQ no re-ejecuta un
   * `jobId` que ya existe en Redis: devuelve el job existente sin error y sin
   * aviso. Con `removeOnFail: 500` vigente, los adjuntos que `mode=failed`
   * existe para recuperar son justamente los que tienen un registro retenido.
   *
   * Liberar un id que estaba esperando (`wait`, `delayed`, `prioritized`) no
   * pierde trabajo: el `addBulk` que viene inmediatamente después lo vuelve a
   * crear con los datos del reprocesamiento, que son los que corresponden.
   *
   * No lanza y no aborta el encolado, en ninguno de los dos desenlaces que no
   * son un borrado limpio:
   *
   * - **Job activo**: no se puede remover porque está bloqueado por el worker
   *   que lo está ejecutando ahora mismo. Es legítimo — ese job va a terminar el
   *   trabajo pedido — y se registra en `debug`, no como error.
   * - **Fallo de Redis**: se registra en `warn` y se sigue. El encolado tiene
   *   que ocurrir igual — en el peor caso el duplicado se absorbe, que es
   *   exactamente el estado del que venimos, no una regresión.
   */
  private async clearPreviousJobs(targets: EnqueueParseTarget[]): Promise<void> {
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        const jobId = dteParseJobId(target.attachmentId);
        try {
          // `Queue.remove` devuelve 1 si liberó el id (o si no había nada que
          // liberar, que para nosotros es lo mismo) y 0 si el job está
          // bloqueado, es decir, ejecutándose ahora mismo.
          const removed = await this.queue.remove(jobId);
          return removed === 0 ? 'active' : 'cleared';
        } catch (err) {
          this.logger.warn(
            { err, jobId, tenantId: target.tenantId, attachmentId: target.attachmentId },
            'No se pudo liberar el registro de job previo; se encola igual y el duplicado puede quedar absorbido',
          );
          return 'failed';
        }
      }),
    );

    const cleared = outcomes.filter((outcome) => outcome === 'cleared').length;
    const active = outcomes.filter((outcome) => outcome === 'active').length;
    const failed = outcomes.filter((outcome) => outcome === 'failed').length;

    this.logger.debug(
      { requested: targets.length, cleared, active, failed },
      'Registros de job previos liberados antes de reprocesar',
    );
  }
}
