import { resolveCanonicalKey } from './canonical-key';

describe('resolveCanonicalKey', () => {
  describe('cascada', () => {
    it('usa el NRC cuando está presente, aunque haya NIT de 14', () => {
      expect(resolveCanonicalKey({ nrc: '1435153', nit: '11022205761034' })).toBe('1435153');
    });

    it('cae al NIT de 14 dígitos cuando no hay NRC', () => {
      expect(resolveCanonicalKey({ nrc: null, nit: '06140203901028' })).toBe('06140203901028');
    });

    it('cae al DUI de 9 dígitos cuando no hay NRC ni NIT de 14', () => {
      expect(resolveCanonicalKey({ nrc: null, nit: '022560911' })).toBe('022560911');
    });

    it('devuelve null cuando no hay ninguno de los tres', () => {
      expect(resolveCanonicalKey({ nrc: null, nit: null })).toBeNull();
      expect(resolveCanonicalKey({})).toBeNull();
      expect(resolveCanonicalKey({ nrc: '', nit: '' })).toBeNull();
    });

    it('devuelve null si el identificador no tiene una longitud reconocible', () => {
      // Proveedor del exterior o identificador mal formado: no se inventa una
      // clave con el número crudo.
      expect(resolveCanonicalKey({ nrc: null, nit: '12345' })).toBeNull();
      expect(resolveCanonicalKey({ nrc: null, nit: '1234567890123456' })).toBeNull();
    });
  });

  describe('normalización', () => {
    it('ignora los separadores del NRC', () => {
      expect(resolveCanonicalKey({ nrc: '143-5153', nit: null })).toBe('1435153');
      expect(resolveCanonicalKey({ nrc: '143 5153', nit: null })).toBe('1435153');
    });

    it('ignora los separadores del NIT y del DUI', () => {
      expect(resolveCanonicalKey({ nrc: null, nit: '0614-020390-102-8' })).toBe('06140203901028');
      expect(resolveCanonicalKey({ nrc: null, nit: '02256091-1' })).toBe('022560911');
    });

    it('quita los ceros a la izquierda del NRC', () => {
      expect(resolveCanonicalKey({ nrc: '0001435153', nit: null })).toBe('1435153');
      expect(resolveCanonicalKey({ nrc: '1435153', nit: null })).toBe('1435153');
    });

    it('NO quita los ceros a la izquierda del NIT ni del DUI', () => {
      // Son de longitud fija: el cero inicial es parte del identificador y
      // recortarlo además rompería la clasificación por longitud de la regla E/P.
      expect(resolveCanonicalKey({ nrc: null, nit: '06140203901028' })).toBe('06140203901028');
      expect(resolveCanonicalKey({ nrc: null, nit: '022560911' })).toBe('022560911');
    });

    it('trata un NRC sin dígitos significativos como ausente', () => {
      // "0000" no es el contribuyente número cero: es un campo basura. Cae a la
      // rama siguiente en vez de inventar una clave con la que agrupar.
      expect(resolveCanonicalKey({ nrc: '0000', nit: '06140203901028' })).toBe('06140203901028');
      expect(resolveCanonicalKey({ nrc: 'N/A', nit: '06140203901028' })).toBe('06140203901028');
    });
  });

  describe('el caso de producción que originó el addendum', () => {
    // Tenant wendy-cocar, 2026-09-09: la misma persona partida en dos partes
    // porque unos proveedores la identifican con el NIT de 14 y otros con el
    // NIT homologado al DUI, de 9. Exportar una deja 7 compras fuera de la
    // declaración, sin error y sin aviso.
    const conNit14 = { nrc: '1435153', nit: '11022205761034' };
    const conDui9 = { nrc: '1435153', nit: '022560911' };

    it('las dos partes de JOSE WALTER CRUZ MARAVILLA resuelven a la misma clave', () => {
      const claveNit14 = resolveCanonicalKey(conNit14);
      const claveDui9 = resolveCanonicalKey(conDui9);

      expect(claveNit14).toBe('1435153');
      expect(claveDui9).toBe('1435153');
      expect(claveNit14).toBe(claveDui9);
    });

    it('sin el NRC las dos partes seguirían separadas, que es el problema actual', () => {
      // Deja explícito por qué el NRC va arriba de la cascada y no abajo.
      expect(resolveCanonicalKey({ nrc: null, nit: conNit14.nit })).not.toBe(
        resolveCanonicalKey({ nrc: null, nit: conDui9.nit }),
      );
    });
  });
});
