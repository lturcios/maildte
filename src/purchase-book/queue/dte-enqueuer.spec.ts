import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { DteEnqueuer, EnqueueParseTarget } from './dte-enqueuer';
import { DTE_QUEUE, DTE_PARSE_JOB_NAME, dteParseJobId } from './dte-queue.constants';

const queueMock = { addBulk: jest.fn() };
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

describe('DteEnqueuer', () => {
  let enqueuer: DteEnqueuer;

  beforeEach(async () => {
    jest.clearAllMocks();
    queueMock.addBulk.mockResolvedValue(undefined);

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
});
