import { Prisma } from '@prisma/client';
import {
  formatFecEmi,
  isNegativeAmount,
  roundToAnexoScale,
  stripHyphens,
  toAnexoAmount,
} from './amount';
import {
  ClassificationDefaults,
  resolveClassification,
  ResolvedClassification,
} from './resolve-classification';
import { splitSupplierId } from './split-supplier-id';

/**
 * Construcción de una fila del Anexo 3 "Detalle de Compras" (Addendum 10, §8.1).
 *
 * REGLA 29 DEL PROYECTO: este archivo es el ÚNICO lugar donde vive el mapeo de
 * las 21 columnas. Los adaptadores de CSV y XLSX consumen las celdas tipadas
 * que devuelve `buildAnexoRow` y no deciden nada sobre el contenido.
 *
 * Columnas, en orden:
 *   A fecEmi (DD/MM/AAAA)          L importaciones gravadas de bienes = 0.00
 *   B clase de documento = 4       M importaciones gravadas de servicios = 0.00
 *   C tipoDte                      N crédito fiscal (IVA 13 %)
 *   D codigoGeneracion sin guiones O total de compras = G + J + N
 *   E NIT del proveedor            P DUI del proveedor
 *   F nombre del proveedor         Q tipo de operación
 *   G exentas y no sujetas         R clasificación
 *   H internaciones exentas = 0.00 S sector
 *   I importaciones exentas = 0.00 T tipo de costo/gasto
 *   J compras internas gravadas    U número de anexo = 3
 *   K internaciones gravadas = 0.00
 */

/** Cantidad de columnas del anexo. Si esto cambia, cambió el instructivo. */
export const ANEXO_COLUMN_COUNT = 21;

/** Columna B: los DTE siempre son "Documento Tributario Electrónico". */
export const CLASE_DOCUMENTO_DTE = '4';

/** Columna U: este es el anexo 3. */
export const NUMERO_ANEXO = '3';

/** Monto cero, para las columnas que un CCF nunca alimenta. */
const ZERO_AMOUNT = '0.00';

/**
 * Celda tipada. El tipo no es decorativo: en XLSX define si el valor va como
 * texto (preserva los ceros a la izquierda de `03`, del NIT y del DUI) o como
 * número con formato `0.00`.
 */
export type AnexoCellKind = 'text' | 'amount' | 'int';

export interface AnexoCell {
  kind: AnexoCellKind;
  /** Valor ya formateado, listo para escribirse tal cual en CSV. */
  value: string;
}

/** Datos del documento que necesita el builder. Es un subconjunto del modelo. */
export interface AnexoDocumentInput {
  fecEmi: Date;
  tipoDte: string;
  codigoGeneracion: string;
  emisorNit: string;
  emisorNombre: string;
  totalExenta: Prisma.Decimal;
  totalNoSuj: Prisma.Decimal;
  totalGravada: Prisma.Decimal;
  ivaCreditoFiscal: Prisma.Decimal;
  montoTotalOperacion: Prisma.Decimal;
  anexoTipoOperacion: number | null;
  anexoClasificacion: number | null;
  anexoSector: number | null;
  anexoTipoCostoGasto: number | null;
}

/** Señales que el export acumula para el resumen y las advertencias del panel. */
export interface AnexoRowFlags {
  /** El identificador del proveedor no mide 9 ni 14 dígitos. */
  supplierIdAnomaly: boolean;
  /** Algún monto venía negativo y se llevó a 0.00. */
  negativeAmount: boolean;
  /** `G + J + N` difiere de `montoTotalOperacion` en más de un centavo. */
  totalMismatch: boolean;
  /** Falta al menos una de las columnas Q–T. */
  incompleteClassification: boolean;
}

export interface AnexoRow {
  cells: AnexoCell[];
  flags: AnexoRowFlags;
  classification: ResolvedClassification;
}

/** Tolerancia de la comparación entre la columna O y `montoTotalOperacion`. */
const MISMATCH_TOLERANCE = new Prisma.Decimal('0.01');

function text(value: string): AnexoCell {
  return { kind: 'text', value };
}

function amount(value: string): AnexoCell {
  return { kind: 'amount', value };
}

function int(value: string): AnexoCell {
  return { kind: 'int', value };
}

/**
 * Arma la fila de un documento.
 *
 * @param doc      documento ya parseado y persistido.
 * @param defaults defaults Q–T del receptor, o `null` si no tiene.
 */
export function buildAnexoRow(
  doc: AnexoDocumentInput,
  defaults: ClassificationDefaults | null,
): AnexoRow {
  const supplier = splitSupplierId(doc.emisorNit);
  const classification = resolveClassification(
    {
      anexoTipoOperacion: doc.anexoTipoOperacion,
      anexoClasificacion: doc.anexoClasificacion,
      anexoSector: doc.anexoSector,
      anexoTipoCostoGasto: doc.anexoTipoCostoGasto,
    },
    defaults,
    doc.fecEmi,
  );

  // Columna G: exentas y no sujetas van juntas en el anexo de compras.
  const exentasYNoSujetas = doc.totalExenta.plus(doc.totalNoSuj);

  // Se redondea ANTES de sumar para que la columna O cierre exactamente con la
  // suma de las columnas ya impresas. Sumar en alta precisión y redondear al
  // final produce diferencias de un centavo contra la verificación de Hacienda.
  const g = roundToAnexoScale(exentasYNoSujetas);
  const j = roundToAnexoScale(doc.totalGravada);
  const n = roundToAnexoScale(doc.ivaCreditoFiscal);
  const o = g.plus(j).plus(n);

  const negativeAmount =
    isNegativeAmount(exentasYNoSujetas) ||
    isNegativeAmount(doc.totalGravada) ||
    isNegativeAmount(doc.ivaCreditoFiscal);

  const totalMismatch = o
    .minus(roundToAnexoScale(doc.montoTotalOperacion))
    .abs()
    .greaterThan(MISMATCH_TOLERANCE);

  const cells: AnexoCell[] = [
    /* A */ text(formatFecEmi(doc.fecEmi)),
    /* B */ int(CLASE_DOCUMENTO_DTE),
    /* C */ text(doc.tipoDte),
    /* D */ text(stripHyphens(doc.codigoGeneracion)),
    /* E */ text(supplier.nit),
    /* F */ text(doc.emisorNombre),
    /* G */ amount(toAnexoAmount(exentasYNoSujetas)),
    /* H */ amount(ZERO_AMOUNT),
    /* I */ amount(ZERO_AMOUNT),
    /* J */ amount(toAnexoAmount(doc.totalGravada)),
    /* K */ amount(ZERO_AMOUNT),
    /* L */ amount(ZERO_AMOUNT),
    /* M */ amount(ZERO_AMOUNT),
    /* N */ amount(toAnexoAmount(doc.ivaCreditoFiscal)),
    /* O */ amount(toAnexoAmount(o)),
    /* P */ text(supplier.dui),
    /* Q */ text(classification.tipoOperacion.value),
    /* R */ text(classification.clasificacion.value),
    /* S */ text(classification.sector.value),
    /* T */ text(classification.tipoCostoGasto.value),
    /* U */ int(NUMERO_ANEXO),
  ];

  return {
    cells,
    flags: {
      supplierIdAnomaly: supplier.anomalous,
      negativeAmount,
      totalMismatch,
      incompleteClassification: classification.incomplete,
    },
    classification,
  };
}
