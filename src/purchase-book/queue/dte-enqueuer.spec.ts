import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { DteEnqueuer, EnqueueParseTarget } from './dte-enqueuer';
import { DTE_QUEUE, DTE_PARSE_JOB_NAME, dteParseJobId } from './dte-queue.constants';

const queueMock = { addBulk: jest.fn(), remove: jest.fn() };
const loggerMock = {
  setContext: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function targets(...attachmentIds: string[]): EnqueueParseTarget[] {
  return attachmentIds.map((attachmentId) => ({ tenantId: 'tenant-1', attachmentId }));
}

/**
 * `addBulk` devuelve un `Job` por cada entrada pedida, incluidas las que BullMQ
 * absorbió como duplicado: no hay forma de distinguirlas desde el cliente. El
 * doble sigue esa forma porque el retorno del método se calcula sobre ella.
 */
function acceptedJobs(jobs: { opts?: { jobId?: string } }[]): { id: string | undefined }[] {
  return jobs.map((job) => ({ id: job.opts?.jobId }));
}

describe('DteEnqueuer', () => {
  let enqueuer: DteEnqueuer;

  beforeEach(async () => {
    jest.clearAllMocks();
    queueMock.addBulk.mockImplementation((jobs: { opts?: { jobId?: string } }[]) =>
      Promise.resolve(acceptedJobs(jobs)),
    );
    queueMock.remove.mockResolvedValue(1);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DteEnqueuer,
        { provide: DTE_QUEUE, useValue: queueMock },
        { provide: PinoLogger, useValue: loggerMock },
      ],
    }).compile();

    enqueuer = moduleRef.get(DteEnqueuer);
  });

  it('devuelve cuántos trabajos aceptó la cola', async () => {
    expect(await enqueuer.enqueueParseBulk(targets('att-1', 'att-2'), 'sync')).toBe(2);

    const jobs = queueMock.addBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      name: DTE_PARSE_JOB_NAME,
      data: { tenantId: 'tenant-1', attachmentId: 'att-1', trigger: 'sync', force: false },
      opts: { jobId: dteParseJobId('att-1') },
    });
  });

  it('no toca Redis cuando no hay nada que encolar', async () => {
    expect(await enqueuer.enqueueParseBulk([], 'sync')).toBe(0);
    expect(queueMock.addBulk).not.toHaveBeenCalled();
  });

  /**
   * Este es el punto ciego que dejó el libro de compras vacío durante siete
   * fases: `dteParseJobId` devolvía `dte:<uuid>`, BullMQ rechazaba el `jobId`
   * por el `:`, `addBulk` lanzaba en cada llamada y este método se tragaba la
   * excepción (por diseño: encolar no puede hacer fallar el archivado de un
   * correo). El único rastro era un `warn` que nadie mira.
   *
   * El contrato que fija esta prueba: NO lanza, devuelve MENOS de lo pedido
   * — la señal que todo llamador está obligado a comparar — y lo registra en
   * nivel `error`, que es lo que llega al alertado.
   */
  it('un lote rechazado no lanza, devuelve menos de lo pedido y se loguea en error', async () => {
    queueMock.addBulk.mockRejectedValue(new Error('Custom Id cannot contain :'));

    const requested = targets('att-1', 'att-2', 'att-3');
    const accepted = await enqueuer.enqueueParseBulk(requested, 'reprocess', true);

    expect(accepted).toBeLessThan(requested.length);
    expect(accepted).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3, trigger: 'reprocess', force: true }),
      expect.stringContaining('el lote se perdió'),
    );
  });

  /**
   * El segundo modo de falla silenciosa de esta cola, verificado en producción
   * el 2026-09-09: el `jobId` es determinístico y BullMQ ignora sin error un
   * `add` cuyo id ya existe en Redis, así que con retención de completados los
   * registros del backfill anterior absorbían el re-encolado. El backfill del
   * Addendum 11 fase 1 reportó 968 trabajos encolados y reprocesó 419 documentos
   * de 862. Sin retención de completados y borrando el id previo antes de
   * encolar, el reprocesamiento vuelve a reprocesar.
   */
  it('no retiene los completados en Redis: el ledger en Postgres es el registro durable', async () => {
    await enqueuer.enqueueParseBulk(targets('att-1'), 'sync');

    expect(queueMock.addBulk.mock.calls[0][0][0].opts).toMatchObject({
      removeOnComplete: true,
      removeOnFail: 500,
    });
  });

  it('el reprocesamiento libera el registro de job previo de cada id antes de encolar', async () => {
    await enqueuer.enqueueParseBulk(targets('att-1', 'att-2'), 'reprocess', true);

    expect(queueMock.remove).toHaveBeenCalledTimes(2);
    expect(queueMock.remove).toHaveBeenCalledWith(dteParseJobId('att-1'));
    expect(queueMock.remove).toHaveBeenCalledWith(dteParseJobId('att-2'));

    // El orden importa: liberar después de encolar borraría el trabajo nuevo.
    expect(queueMock.remove.mock.invocationCallOrder[0]).toBeLessThan(
      queueMock.addBulk.mock.invocationCallOrder[0],
    );
  });

  /**
   * En el `sync` el colapso de duplicados es el comportamiento deseado: si el
   * job del adjunto todavía está pendiente, un segundo encolado no tiene que
   * duplicar el trabajo. Solo el reprocesamiento pide explícitamente releer.
   */
  it('el sync NO libera los ids previos', async () => {
    await enqueuer.enqueueParseBulk(targets('att-1', 'att-2'), 'sync');

    expect(queueMock.remove).not.toHaveBeenCalled();
    expect(queueMock.addBulk).toHaveBeenCalledTimes(1);
  });

  it('un job activo no se puede liberar y eso no es un error: se encola igual', async () => {
    queueMock.remove.mockResolvedValue(0); // BullMQ devuelve 0 con el job bloqueado

    expect(await enqueuer.enqueueParseBulk(targets('att-1'), 'reprocess')).toBe(1);
    expect(queueMock.addBulk).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  /**
   * Liberar el id es una mejora del reprocesamiento, no una precondición: si
   * Redis rechaza la remoción, encolar igual deja el sistema en el estado del
   * que venimos (duplicado absorbido), y no encolar lo dejaría peor.
   */
  it('si falla la liberación de un id, el encolado ocurre igual y el método no lanza', async () => {
    queueMock.remove.mockRejectedValueOnce(new Error('Redis caído')).mockResolvedValueOnce(1);

    const accepted = await enqueuer.enqueueParseBulk(targets('att-1', 'att-2'), 'reprocess');

    expect(accepted).toBe(2);
    expect(queueMock.addBulk).toHaveBeenCalledTimes(1);
    expect(queueMock.addBulk.mock.calls[0][0]).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: dteParseJobId('att-1'), attachmentId: 'att-1' }),
      expect.stringContaining('No se pudo liberar el registro de job previo'),
    );
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});
