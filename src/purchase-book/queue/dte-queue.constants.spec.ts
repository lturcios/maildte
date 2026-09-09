import { dteParseJobId } from './dte-queue.constants';

describe('dteParseJobId', () => {
  it('es determinístico: el mismo adjunto siempre da el mismo id', () => {
    const attachmentId = '11111111-2222-3333-4444-555555555555';
    expect(dteParseJobId(attachmentId)).toBe(dteParseJobId(attachmentId));
  });

  it('distingue adjuntos distintos', () => {
    expect(dteParseJobId('a')).not.toBe(dteParseJobId('b'));
  });

  /**
   * Regresión: BullMQ rechaza un `jobId` con `:` (salvo que tenga exactamente
   * dos, por compatibilidad con los repetibles viejos). `enqueueParseBulk`
   * captura esa excepción y devuelve 0, así que con un separador inválido la
   * cola quedaba vacía sin un solo error visible.
   */
  it('no usa ":" como separador, porque BullMQ rechaza ese jobId', () => {
    expect(dteParseJobId('11111111-2222-3333-4444-555555555555')).not.toContain(':');
  });
});
