import { Prisma } from '@prisma/client';
import { parseDte, PARSER_VERSION } from './dte-parser';
import { ParsedCcf } from './dte-parser.types';
import ccfV3 from '../__fixtures__/ccf-v3.json';
import ccfV4 from '../__fixtures__/ccf-v4.json';

/**
 * Los fixtures son los dos DTE reales del proyecto: v3 con `ivaRete1` y
 * `extension`, v4 con `ivaRete`, `direccion.distrito` y sin `extension`.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Extrae el DTE de un outcome que debe ser `parsed`, o falla el test. */
function expectParsed(raw: unknown): ParsedCcf {
  const outcome = parseDte(raw);
  if (outcome.kind !== 'parsed') {
    throw new Error(
      `se esperaba kind=parsed, llegó kind=${outcome.kind} ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.dte;
}

describe('parseDte', () => {
  it('expone una versión de parser entera y positiva', () => {
    expect(Number.isInteger(PARSER_VERSION)).toBe(true);
    expect(PARSER_VERSION).toBeGreaterThan(0);
  });

  describe('CCF versión 3', () => {
    const dte = expectParsed(ccfV3);

    it('normaliza la identificación', () => {
      expect(dte.identificacion.version).toBe(3);
      expect(dte.identificacion.tipoDte).toBe('03');
      expect(dte.identificacion.codigoGeneracion).toBe('FC5B1AE1-07F1-42CA-A7DA-AB4F8A3381D2');
      expect(dte.identificacion.numeroControl).toBe('DTE-03-M001P001-000000000000077');
      expect(dte.identificacion.fecEmi.toISOString()).toBe('2026-03-19T00:00:00.000Z');
      expect(dte.identificacion.horEmi).toBe('01:32:25');
      expect(dte.identificacion.tipoContingencia).toBeNull();
    });

    it('mapea ivaRete1 (v3) a ivaRetenido', () => {
      expect(dte.resumen.ivaRetenido.toString()).toBe('1.77');
      expect(dte.resumen.ivaPercibido.toString()).toBe('0');
      expect(dte.resumen.retencionRenta.toString()).toBe('0');
    });

    it('toma el crédito fiscal del tributo 20', () => {
      expect(dte.resumen.ivaCreditoFiscal.toString()).toBe('23.01');
      expect(dte.taxes).toHaveLength(1);
      expect(dte.taxes[0]).toMatchObject({
        codigo: '20',
        descripcion: 'Impuesto al Valor Agregado 13%',
      });
    });

    it('conserva los campos de establecimiento que solo trae la v3', () => {
      expect(dte.emisorExtras.tipoEstablecimiento).toBe('02');
      expect(dte.emisorExtras.codEstable).toBe('M001');
      expect(dte.emisorExtras.codPuntoVenta).toBe('P001');
    });

    it('archiva extension sin normalizar y deja distrito en null', () => {
      expect(dte.passthrough.extension).not.toBeNull();
      expect(dte.emisor.distrito).toBeNull();
      expect(dte.passthrough.selloRecibido).toBe('2026492CA62A9A6F4AD1A07C2FFA474861A2YD61');
    });

    it('preserva la precisión de precioUni sin pasar por float', () => {
      expect(dte.items).toHaveLength(1);
      expect(dte.items[0].precioUni.toString()).toBe('176.99115044');
      expect(dte.items[0].ventaGravada.toString()).toBe('176.99');
      expect(dte.items[0].tributos).toEqual(['20']);
    });

    it('lee emisor y receptor con sus identificadores', () => {
      expect(dte.emisor.nit).toBe('040522092');
      expect(dte.emisor.nombre).toBe('Manuel Eduardo Umanzor Jiménez');
      expect(dte.receptor.nit).toBe('12171609731022');
      expect(dte.receptor.nombre).toBe('DILMA EUNICE RIVERA BONILLA');
    });

    it('normaliza los pagos con su posición', () => {
      expect(dte.payments).toHaveLength(1);
      expect(dte.payments[0].position).toBe(0);
      expect(dte.payments[0].codigo).toBe('01');
      expect(dte.payments[0].montoPago.toString()).toBe('198.23');
    });
  });

  describe('CCF versión 4', () => {
    const dte = expectParsed(ccfV4);

    it('normaliza la identificación', () => {
      expect(dte.identificacion.version).toBe(4);
      expect(dte.identificacion.tipoDte).toBe('03');
      expect(dte.identificacion.fecEmi.toISOString()).toBe('2026-05-28T00:00:00.000Z');
    });

    it('mapea ivaRete/ivaPerci (v4) y no falla porque valgan cero', () => {
      expect(dte.resumen.ivaRetenido.toString()).toBe('0');
      expect(dte.resumen.ivaPercibido.toString()).toBe('0');
      expect(dte.resumen.retencionRenta.toString()).toBe('0');
    });

    it('captura distrito, que solo existe en v4', () => {
      expect(dte.emisor.distrito).toBe('17');
      expect(dte.receptor.distrito).toBe('10');
    });

    it('deja extension en null cuando el documento no la trae', () => {
      expect(dte.passthrough.extension).toBeNull();
      expect(dte.resumen.observaciones).toBeNull();
    });

    it('no arrastra los campos de establecimiento propios de v3', () => {
      expect(dte.emisorExtras.tipoEstablecimiento).toBeNull();
      expect(dte.emisorExtras.codEstable).toBe('M001');
    });

    it('normaliza los dos ítems del documento', () => {
      expect(dte.items).toHaveLength(2);
      expect(dte.items[0].descripcion).toBe('Audífonos Gaming con Micrófono');
      expect(dte.items[1].precioUni.toString()).toBe('85');
      expect(dte.items[1].numItem).toBe(2);
    });

    it('calcula el crédito fiscal y los totales', () => {
      expect(dte.resumen.totalGravada.toString()).toBe('144');
      expect(dte.resumen.ivaCreditoFiscal.toString()).toBe('18.72');
      expect(dte.resumen.montoTotalOperacion.toString()).toBe('162.72');
    });
  });

  describe('clasificación del archivo', () => {
    it('rechaza lo que no es un objeto', () => {
      expect(parseDte(null).kind).toBe('not-dte');
      expect(parseDte([]).kind).toBe('not-dte');
      expect(parseDte('DTE').kind).toBe('not-dte');
      expect(parseDte(42).kind).toBe('not-dte');
      expect(parseDte(undefined).kind).toBe('not-dte');
    });

    it('rechaza un objeto sin identificación', () => {
      expect(parseDte({}).kind).toBe('not-dte');
      expect(parseDte({ cualquier: 'cosa' }).kind).toBe('not-dte');
    });

    it('marca las versiones fuera de {3, 4} sin intentar adivinar', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.identificacion as Record<string, unknown>).version = 2;

      const outcome = parseDte(raw);
      expect(outcome.kind).toBe('unsupported-version');
      if (outcome.kind === 'unsupported-version') {
        expect(outcome.version).toBe(2);
        expect(outcome.tipoDte).toBe('03');
        expect(outcome.codigoGeneracion).toBe('0B4E2221-74CF-4550-A451-31BBFB5CC9FD');
      }
    });

    it('ignora los tipos de DTE que no son crédito fiscal, conservando el tipo', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.identificacion as Record<string, unknown>).tipoDte = '01';

      const outcome = parseDte(raw);
      expect(outcome.kind).toBe('ignored-type');
      if (outcome.kind === 'ignored-type') {
        expect(outcome.tipoDte).toBe('01');
        expect(outcome.version).toBe(4);
      }
    });

    it('trata una nota de crédito como tipo ignorado, no como error', () => {
      const raw = clone(ccfV3) as Record<string, unknown>;
      (raw.identificacion as Record<string, unknown>).tipoDte = '05';
      expect(parseDte(raw).kind).toBe('ignored-type');
    });
  });

  describe('errores de contenido', () => {
    it('reporta el campo faltante con su ruta en español', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      delete (raw.resumen as Record<string, unknown>).totalGravada;

      const outcome = parseDte(raw);
      expect(outcome.kind).toBe('invalid');
      if (outcome.kind === 'invalid') {
        expect(outcome.errors).toContainEqual({
          path: 'resumen.totalGravada',
          message: 'campo obligatorio ausente',
        });
        expect(outcome.version).toBe(4);
        expect(outcome.tipoDte).toBe('03');
      }
    });

    it('acumula todos los errores de una pasada, no solo el primero', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      delete (raw.resumen as Record<string, unknown>).totalGravada;
      delete (raw.resumen as Record<string, unknown>).totalPagar;
      delete (raw.emisor as Record<string, unknown>).nombre;

      const outcome = parseDte(raw);
      expect(outcome.kind).toBe('invalid');
      if (outcome.kind === 'invalid') {
        const paths = outcome.errors.map((error) => error.path);
        expect(paths).toEqual(
          expect.arrayContaining(['resumen.totalGravada', 'resumen.totalPagar', 'emisor.nombre']),
        );
      }
    });

    it('reporta un tipo equivocado en un monto', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.resumen as Record<string, unknown>).totalGravada = 'no es un número';

      const outcome = parseDte(raw);
      expect(outcome.kind).toBe('invalid');
      if (outcome.kind === 'invalid') {
        expect(outcome.errors).toContainEqual({
          path: 'resumen.totalGravada',
          message: 'se esperaba un número',
        });
      }
    });

    it('rechaza un cuerpoDocumento vacío', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      raw.cuerpoDocumento = [];
      expect(parseDte(raw).kind).toBe('invalid');
    });
  });

  describe('tolerancia a variantes del emisor', () => {
    it('acepta montos como string numérico', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.resumen as Record<string, unknown>).totalGravada = '144.00';

      const dte = expectParsed(raw);
      expect(dte.resumen.totalGravada.toString()).toBe('144');
      expect(dte.resumen.totalGravada).toBeInstanceOf(Prisma.Decimal);
    });

    it('convierte tributos null del ítem en arreglo vacío', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      const items = raw.cuerpoDocumento as Record<string, unknown>[];
      items[0].tributos = null;

      const dte = expectParsed(raw);
      expect(dte.items[0].tributos).toEqual([]);
    });

    it('vale cero cuando faltan los campos de retención', () => {
      const raw = clone(ccfV3) as Record<string, unknown>;
      delete (raw.resumen as Record<string, unknown>).ivaRete1;
      delete (raw.resumen as Record<string, unknown>).reteRenta;

      const dte = expectParsed(raw);
      expect(dte.resumen.ivaRetenido.toString()).toBe('0');
      expect(dte.resumen.retencionRenta.toString()).toBe('0');
    });

    it('toma observaciones desde extension cuando el resumen no las trae (v3)', () => {
      const raw = clone(ccfV3) as Record<string, unknown>;
      (raw.extension as Record<string, unknown>).observaciones = 'Compra de oficina';

      const dte = expectParsed(raw);
      expect(dte.resumen.observaciones).toBe('Compra de oficina');
    });

    it('deja el crédito fiscal en cero si no viene el tributo 20', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.resumen as Record<string, unknown>).tributos = [];

      const dte = expectParsed(raw);
      expect(dte.resumen.ivaCreditoFiscal.toString()).toBe('0');
      expect(dte.taxes).toHaveLength(0);
    });

    it('consolida un tributo repetido en vez de romper la unicidad de la tabla hija', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      (raw.resumen as Record<string, unknown>).tributos = [
        { codigo: '20', descripcion: 'IVA 13%', valor: 10 },
        { codigo: '20', descripcion: 'IVA 13%', valor: 8.72 },
      ];

      const dte = expectParsed(raw);
      expect(dte.taxes).toHaveLength(1);
      expect(dte.taxes[0].valor.toString()).toBe('18.72');
    });

    it('parsea aunque el emisor omita la dirección', () => {
      const raw = clone(ccfV4) as Record<string, unknown>;
      delete (raw.emisor as Record<string, unknown>).direccion;

      const dte = expectParsed(raw);
      expect(dte.emisor.departamento).toBeNull();
      expect(dte.emisor.complemento).toBeNull();
    });
  });

  describe('seguridad', () => {
    it('no contamina Object.prototype con una clave __proto__ del archivo', () => {
      // JSON.parse crea __proto__ como propiedad propia, que es justo el vector
      // que el parser tiene que ignorar: solo lee valores, nunca hace merge.
      const raw = JSON.parse(
        JSON.stringify(ccfV4).replace('"emisor":{', '"emisor":{"__proto__":{"polluted":true},'),
      ) as Record<string, unknown>;

      const outcome = parseDte(raw);

      expect(outcome.kind).toBe('parsed');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    });

    it('ignora un constructor malicioso en el resumen', () => {
      const raw = JSON.parse(
        JSON.stringify(ccfV4).replace('"resumen":{', '"resumen":{"constructor":{"x":1},'),
      ) as Record<string, unknown>;

      expect(parseDte(raw).kind).toBe('parsed');
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('no toma valores heredados del prototipo', () => {
      const base = { totalGravada: 999 };
      const resumen = Object.create(base) as Record<string, unknown>;
      const raw = clone(ccfV4) as Record<string, unknown>;
      raw.resumen = resumen;

      // Sin propiedades propias, el resumen heredado no aporta ningún campo.
      expect(parseDte(raw).kind).toBe('invalid');
    });
  });
});
