import { Prisma } from '@prisma/client';
import { DteFieldError } from './json-access';

/**
 * Tipos del parser de DTE (Addendum 10, §6.1).
 *
 * Todo lo de este archivo es una estructura plana lista para el `create` de
 * Prisma: montos como `Prisma.Decimal`, fechas como `Date`, nada de clases de
 * Nest ni del cliente de base de datos.
 */

/** Versiones del esquema de Hacienda que este parser normaliza. */
export const SUPPORTED_VERSIONS = [3, 4] as const;

/** Comprobante de Crédito Fiscal: el único tipo que alimenta el libro de compras. */
export const TIPO_DTE_CCF = '03';

/** Código del tributo IVA 13 % en `resumen.tributos` (columna N del Anexo 3). */
export const TRIBUTO_IVA = '20';

export interface ParsedIdentificacion {
  version: number;
  ambiente: string;
  tipoDte: string;
  numeroControl: string;
  codigoGeneracion: string;
  tipoModelo: number;
  tipoOperacion: number;
  tipoContingencia: number | null;
  motivoContin: string | null;
  /** Fecha calendario, anclada a medianoche UTC (la columna es DATE). */
  fecEmi: Date;
  horEmi: string;
  tipoMoneda: string;
}

/** Datos de una parte (emisor o receptor) tal como vienen en el DTE. */
export interface ParsedParty {
  nit: string;
  nrc: string | null;
  nombre: string;
  nombreComercial: string | null;
  codActividad: string | null;
  descActividad: string | null;
  departamento: string | null;
  municipio: string | null;
  /** Solo en v4; en v3 la dirección no lo trae. */
  distrito: string | null;
  complemento: string | null;
  telefono: string | null;
  correo: string | null;
}

/** Campos que solo tiene el emisor y que se guardan como snapshot del documento. */
export interface ParsedEmisorExtras {
  /** Solo v3. */
  tipoEstablecimiento: string | null;
  codEstable: string | null;
  codPuntoVenta: string | null;
}

export interface ParsedItem {
  numItem: number;
  tipoItem: number;
  numeroDocumento: string | null;
  cantidad: Prisma.Decimal;
  codigo: string | null;
  codTributo: string | null;
  uniMedida: number;
  descripcion: string;
  precioUni: Prisma.Decimal;
  montoDescu: Prisma.Decimal;
  ventaNoSuj: Prisma.Decimal;
  ventaExenta: Prisma.Decimal;
  ventaGravada: Prisma.Decimal;
  tributos: string[];
  psv: Prisma.Decimal;
  noGravado: Prisma.Decimal;
}

export interface ParsedTax {
  codigo: string;
  descripcion: string;
  valor: Prisma.Decimal;
}

export interface ParsedPayment {
  position: number;
  codigo: string;
  montoPago: Prisma.Decimal;
  referencia: string | null;
  plazo: string | null;
  periodo: number | null;
}

/**
 * Resumen ya normalizado entre v3 y v4: los alias `ivaRete1`/`ivaRete`,
 * `ivaPerci1`/`ivaPerci` y `reteRenta` colapsan en tres campos únicos.
 */
export interface ParsedResumen {
  totalNoSuj: Prisma.Decimal;
  totalExenta: Prisma.Decimal;
  totalGravada: Prisma.Decimal;
  subTotalVentas: Prisma.Decimal;
  descuNoSuj: Prisma.Decimal;
  descuExenta: Prisma.Decimal;
  descuGravada: Prisma.Decimal;
  porcentajeDescuento: Prisma.Decimal;
  totalDescu: Prisma.Decimal;
  subTotal: Prisma.Decimal;
  ivaRetenido: Prisma.Decimal;
  ivaPercibido: Prisma.Decimal;
  retencionRenta: Prisma.Decimal;
  /** `resumen.tributos[codigo = "20"].valor`; cero si el tributo no aparece. */
  ivaCreditoFiscal: Prisma.Decimal;
  montoTotalOperacion: Prisma.Decimal;
  totalNoGravado: Prisma.Decimal;
  totalPagar: Prisma.Decimal;
  saldoFavor: Prisma.Decimal;
  totalLetras: string;
  condicionOperacion: number;
  numPagoElectronico: string | null;
  /** `resumen.observaciones` (v4) o `extension.observaciones` (v3). */
  observaciones: string | null;
}

/** Secciones que se archivan sin normalizar, como `jsonb` (ADR-10.8). */
export interface ParsedPassthrough {
  selloRecibido: string | null;
  documentoRelacionado: unknown;
  otrosDocumentos: unknown;
  ventaTercero: unknown;
  extension: unknown;
  apendice: unknown;
}

/** Un CCF completo, listo para persistirse. */
export interface ParsedCcf {
  identificacion: ParsedIdentificacion;
  emisor: ParsedParty;
  emisorExtras: ParsedEmisorExtras;
  receptor: ParsedParty;
  resumen: ParsedResumen;
  items: ParsedItem[];
  taxes: ParsedTax[];
  payments: ParsedPayment[];
  passthrough: ParsedPassthrough;
}

/**
 * Resultado del parseo. Cada variante mapea a un `DteParseStatus` del ledger:
 *
 * | kind                  | DteParseStatus       |
 * |-----------------------|----------------------|
 * | `parsed`              | PARSEADO / DUPLICADO |
 * | `ignored-type`        | IGNORADO_TIPO        |
 * | `unsupported-version` | VERSION_NO_SOPORTADA |
 * | `not-dte`             | NO_ES_DTE            |
 * | `invalid`             | ERROR                |
 */
export type ParseOutcome =
  | { kind: 'parsed'; dte: ParsedCcf }
  | { kind: 'not-dte' }
  | {
      kind: 'unsupported-version';
      version: number | null;
      tipoDte: string | null;
      codigoGeneracion: string | null;
    }
  | {
      kind: 'ignored-type';
      tipoDte: string;
      version: number;
      codigoGeneracion: string | null;
    }
  | {
      kind: 'invalid';
      errors: DteFieldError[];
      tipoDte: string | null;
      version: number | null;
      codigoGeneracion: string | null;
    };
