import { Prisma } from '@prisma/client';

/**
 * Proyecciones del libro de compras (Addendum 10, §7).
 *
 * `satisfies` en vez de anotación de tipo: valida las claves contra el modelo
 * de Prisma pero conserva el tipo literal, así el retorno de cada consulta
 * queda tipado con exactitud y no como el modelo completo.
 */

/** Defaults Q–T del receptor: lo que necesita `resolveClassification`. */
export const PARTY_DEFAULTS_SELECT = {
  defaultTipoOperacion: true,
  defaultClasificacion: true,
  defaultSector: true,
  defaultTipoCostoGasto: true,
} satisfies Prisma.DtePartySelect;

export const PARTY_SELECT = {
  id: true,
  nit: true,
  nrc: true,
  nombre: true,
  nombreComercial: true,
  codActividad: true,
  descActividad: true,
  seenAsEmisor: true,
  seenAsReceptor: true,
  ...PARTY_DEFAULTS_SELECT,
} satisfies Prisma.DtePartySelect;

/**
 * Listado: sin `rawJson` ni tablas hijas. Una página de 200 documentos con el
 * JSON crudo adentro serían varios MB por request sin que nadie los mire.
 */
export const DOCUMENT_LIST_SELECT = {
  id: true,
  fecEmi: true,
  tipoDte: true,
  numeroControl: true,
  codigoGeneracion: true,
  emisorNit: true,
  emisorNombre: true,
  receptorNit: true,
  receptorNombre: true,
  totalExenta: true,
  totalNoSuj: true,
  totalGravada: true,
  ivaCreditoFiscal: true,
  montoTotalOperacion: true,
  anexoTipoOperacion: true,
  anexoClasificacion: true,
  anexoSector: true,
  anexoTipoCostoGasto: true,
  anexoNota: true,
  createdAt: true,
  emisor: { select: { id: true, nombre: true, nit: true } },
  receptor: { select: { id: true, nombre: true, nit: true, ...PARTY_DEFAULTS_SELECT } },
} satisfies Prisma.PurchaseDocumentSelect;

/**
 * Export: solo lo que consume `buildAnexoRow`, más los defaults del receptor y
 * el NIT del receptor, que no va en ninguna columna del anexo pero nombra el
 * archivo (el Anexo 3 se presenta por contribuyente).
 */
export const DOCUMENT_EXPORT_SELECT = {
  id: true,
  fecEmi: true,
  tipoDte: true,
  codigoGeneracion: true,
  emisorNit: true,
  emisorNombre: true,
  receptorNit: true,
  totalExenta: true,
  totalNoSuj: true,
  totalGravada: true,
  ivaCreditoFiscal: true,
  montoTotalOperacion: true,
  anexoTipoOperacion: true,
  anexoClasificacion: true,
  anexoSector: true,
  anexoTipoCostoGasto: true,
  receptor: { select: PARTY_DEFAULTS_SELECT },
} satisfies Prisma.PurchaseDocumentSelect;

/** Detalle: todo salvo `rawJson`, que se agrega aparte y solo para ADMIN. */
export const DOCUMENT_DETAIL_SELECT = {
  id: true,
  attachmentId: true,
  emailId: true,
  accountId: true,
  version: true,
  ambiente: true,
  tipoDte: true,
  numeroControl: true,
  codigoGeneracion: true,
  tipoModelo: true,
  tipoOperacion: true,
  tipoContingencia: true,
  motivoContin: true,
  fecEmi: true,
  horEmi: true,
  tipoMoneda: true,
  emisorNit: true,
  emisorNrc: true,
  emisorNombre: true,
  emisorNombreComercial: true,
  emisorCodActividad: true,
  emisorTipoEstablecimiento: true,
  emisorCodEstable: true,
  emisorCodPuntoVenta: true,
  receptorNit: true,
  receptorNrc: true,
  receptorNombre: true,
  receptorNombreComercial: true,
  totalNoSuj: true,
  totalExenta: true,
  totalGravada: true,
  subTotalVentas: true,
  descuNoSuj: true,
  descuExenta: true,
  descuGravada: true,
  porcentajeDescuento: true,
  totalDescu: true,
  subTotal: true,
  ivaRetenido: true,
  ivaPercibido: true,
  retencionRenta: true,
  ivaCreditoFiscal: true,
  montoTotalOperacion: true,
  totalNoGravado: true,
  totalPagar: true,
  saldoFavor: true,
  totalLetras: true,
  condicionOperacion: true,
  numPagoElectronico: true,
  observaciones: true,
  selloRecibido: true,
  documentoRelacionado: true,
  otrosDocumentos: true,
  ventaTercero: true,
  extension: true,
  apendice: true,
  anexoTipoOperacion: true,
  anexoClasificacion: true,
  anexoSector: true,
  anexoTipoCostoGasto: true,
  anexoNota: true,
  classifiedById: true,
  classifiedAt: true,
  parserVersion: true,
  createdAt: true,
  updatedAt: true,
  emisor: { select: PARTY_SELECT },
  receptor: { select: PARTY_SELECT },
  items: { orderBy: { numItem: 'asc' } },
  taxes: { orderBy: { codigo: 'asc' } },
  payments: { orderBy: { position: 'asc' } },
} satisfies Prisma.PurchaseDocumentSelect;

export const PARSE_RESULT_SELECT = {
  id: true,
  attachmentId: true,
  status: true,
  tipoDte: true,
  version: true,
  codigoGeneracion: true,
  documentId: true,
  errorDetail: true,
  parserVersion: true,
  parsedAt: true,
  attachment: {
    select: { originalName: true, relativePath: true, emailId: true, sizeBytes: true },
  },
} satisfies Prisma.DteParseResultSelect;

export type PurchaseDocumentListRow = Prisma.PurchaseDocumentGetPayload<{
  select: typeof DOCUMENT_LIST_SELECT;
}>;

export type PurchaseDocumentExportRow = Prisma.PurchaseDocumentGetPayload<{
  select: typeof DOCUMENT_EXPORT_SELECT;
}>;

export type PurchaseDocumentDetailRow = Prisma.PurchaseDocumentGetPayload<{
  select: typeof DOCUMENT_DETAIL_SELECT;
}>;

export type DtePartyRow = Prisma.DtePartyGetPayload<{ select: typeof PARTY_SELECT }>;
