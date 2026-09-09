import { Prisma } from '@prisma/client';
import {
  DteErrorCollector,
  getAliasedDecimalOrZero,
  getAliasedOptionalString,
  getDecimalOrZero,
  getOptionalArray,
  getOptionalInt,
  getOptionalObject,
  getOptionalString,
  getRawSection,
  getRequiredArray,
  getRequiredDecimal,
  getRequiredInt,
  getRequiredObject,
  getRequiredString,
  isPlainObject,
  readOwn,
} from './json-access';
import {
  ParsedEmisorExtras,
  ParsedIdentificacion,
  ParsedItem,
  ParsedParty,
  ParsedPassthrough,
  ParsedPayment,
  ParsedResumen,
  ParsedTax,
  ParseOutcome,
  SUPPORTED_VERSIONS,
  TIPO_DTE_CCF,
  TRIBUTO_IVA,
} from './dte-parser.types';

/**
 * Parser de DTE de El Salvador para el libro de compras (Addendum 10, §6.1).
 *
 * Es una función pura: sin IO, sin Nest, sin acceso a base de datos. Todo lo
 * que necesita llega por parámetro y todo lo que reporta sale por el retorno,
 * de modo que se pueda testear con fixtures sin levantar nada.
 *
 * Tolerancia deliberada: campos extra se ignoran, los alias de v3 y v4 se
 * normalizan, y los campos de retención/percepción ausentes valen cero en vez
 * de ser error, porque la mayoría de los emisores no los envían.
 *
 * PARSER_VERSION sube en DOS casos, y el segundo es el que se pasa por alto:
 *
 * 1. Cambia la semántica de normalización de este archivo.
 * 2. Cambia QUÉ SE PERSISTE de lo que el parser ya devolvía — un campo que se
 *    extraía y se descartaba y ahora se guarda. El parser queda intacto, así
 *    que leyendo solo este archivo el bump parece innecesario; no lo es. La
 *    versión no describe al parser: marca con qué contrato se leyó cada
 *    documento, y ese contrato incluye las columnas que se llenaron.
 *
 * En los dos casos hay que correr después el backfill en modo `failed`
 * (RUNBOOK §9) para re-leer lo viejo con la versión nueva.
 *
 * Historial:
 * - 1: Addendum 10. Versión inicial.
 * - 2: Addendum 11, fase 1. El parser no cambió; se empezaron a persistir
 *      `receptorCodActividad`, `receptorDescActividad` y `DteParty.canonicalKey`.
 */
export const PARSER_VERSION = 2;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Claves alias del resumen: v3 usa la primera, v4 la segunda. */
const ALIAS_IVA_RETENIDO = ['ivaRete1', 'ivaRete'] as const;
const ALIAS_IVA_PERCIBIDO = ['ivaPerci1', 'ivaPerci'] as const;
const ALIAS_RETENCION_RENTA = ['reteRenta', 'reteRenta1'] as const;

function isSupportedVersion(version: number): boolean {
  return (SUPPORTED_VERSIONS as readonly number[]).includes(version);
}

/**
 * Convierte `YYYY-MM-DD` a medianoche UTC. La columna es DATE (sin zona), así
 * que anclar en UTC evita que el offset local corra la fecha un día.
 */
function parseFecEmi(raw: string, path: string, errors: DteErrorCollector): Date | null {
  if (!DATE_ONLY.test(raw)) {
    errors.add(path, 'se esperaba una fecha con formato YYYY-MM-DD');
    return null;
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    errors.add(path, 'fecha inválida');
    return null;
  }
  return date;
}

function parseIdentificacion(
  obj: Record<string, unknown>,
  errors: DteErrorCollector,
): ParsedIdentificacion | null {
  const path = 'identificacion';
  const version = getRequiredInt(obj, 'version', path, errors);
  const ambiente = getRequiredString(obj, 'ambiente', path, errors);
  const tipoDte = getRequiredString(obj, 'tipoDte', path, errors);
  const numeroControl = getRequiredString(obj, 'numeroControl', path, errors);
  const codigoGeneracion = getRequiredString(obj, 'codigoGeneracion', path, errors);
  const tipoModelo = getRequiredInt(obj, 'tipoModelo', path, errors);
  const tipoOperacion = getRequiredInt(obj, 'tipoOperacion', path, errors);
  const fecEmiRaw = getRequiredString(obj, 'fecEmi', path, errors);
  const horEmi = getRequiredString(obj, 'horEmi', path, errors);
  const tipoMoneda = getRequiredString(obj, 'tipoMoneda', path, errors);

  const fecEmi = fecEmiRaw === null ? null : parseFecEmi(fecEmiRaw, `${path}.fecEmi`, errors);

  if (
    version === null ||
    ambiente === null ||
    tipoDte === null ||
    numeroControl === null ||
    codigoGeneracion === null ||
    tipoModelo === null ||
    tipoOperacion === null ||
    fecEmi === null ||
    horEmi === null ||
    tipoMoneda === null
  ) {
    return null;
  }

  return {
    version,
    ambiente,
    tipoDte,
    numeroControl,
    codigoGeneracion,
    tipoModelo,
    tipoOperacion,
    tipoContingencia: getOptionalInt(obj, 'tipoContingencia', path, errors),
    motivoContin: getOptionalString(obj, 'motivoContin', path, errors),
    fecEmi,
    horEmi,
    tipoMoneda,
  };
}

/**
 * Emisor y receptor comparten forma. La dirección es opcional como objeto: hay
 * emisores que la omiten y no es dato del Anexo 3, así que no bloquea el parseo.
 */
function parseParty(
  obj: Record<string, unknown>,
  path: string,
  errors: DteErrorCollector,
): ParsedParty | null {
  const nit = getRequiredString(obj, 'nit', path, errors);
  const nombre = getRequiredString(obj, 'nombre', path, errors);
  const direccion = getOptionalObject(obj, 'direccion', path, errors);

  if (nit === null || nombre === null) return null;

  return {
    nit,
    nrc: getOptionalString(obj, 'nrc', path, errors),
    nombre,
    nombreComercial: getOptionalString(obj, 'nombreComercial', path, errors),
    codActividad: getOptionalString(obj, 'codActividad', path, errors),
    descActividad: getOptionalString(obj, 'descActividad', path, errors),
    departamento:
      direccion === null
        ? null
        : getOptionalString(direccion, 'departamento', `${path}.direccion`, errors),
    municipio:
      direccion === null
        ? null
        : getOptionalString(direccion, 'municipio', `${path}.direccion`, errors),
    distrito:
      direccion === null
        ? null
        : getOptionalString(direccion, 'distrito', `${path}.direccion`, errors),
    complemento:
      direccion === null
        ? null
        : getOptionalString(direccion, 'complemento', `${path}.direccion`, errors),
    telefono: getOptionalString(obj, 'telefono', path, errors),
    correo: getOptionalString(obj, 'correo', path, errors),
  };
}

function parseEmisorExtras(
  obj: Record<string, unknown>,
  errors: DteErrorCollector,
): ParsedEmisorExtras {
  const path = 'emisor';
  return {
    tipoEstablecimiento: getOptionalString(obj, 'tipoEstablecimiento', path, errors),
    codEstable: getOptionalString(obj, 'codEstable', path, errors),
    codPuntoVenta: getOptionalString(obj, 'codPuntoVenta', path, errors),
  };
}

/** `tributos` del ítem es `string[] | null`; cualquier entrada no textual se descarta. */
function parseItemTributos(
  item: Record<string, unknown>,
  path: string,
  errors: DteErrorCollector,
): string[] {
  const raw = getOptionalArray(item, 'tributos', path, errors);
  const codes: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      codes.push(entry.trim());
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      codes.push(String(entry));
    } else {
      errors.add(`${path}.tributos`, 'se esperaba una lista de códigos de tributo');
    }
  }
  return codes;
}

function parseItems(raw: unknown[], errors: DteErrorCollector): ParsedItem[] | null {
  const items: ParsedItem[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const path = `cuerpoDocumento[${i}]`;
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      errors.add(path, 'se esperaba un objeto');
      continue;
    }

    const numItem = getRequiredInt(entry, 'numItem', path, errors);
    const tipoItem = getRequiredInt(entry, 'tipoItem', path, errors);
    const uniMedida = getRequiredInt(entry, 'uniMedida', path, errors);
    const descripcion = getRequiredString(entry, 'descripcion', path, errors);
    const cantidad = getRequiredDecimal(entry, 'cantidad', path, errors);
    const precioUni = getRequiredDecimal(entry, 'precioUni', path, errors);

    if (
      numItem === null ||
      tipoItem === null ||
      uniMedida === null ||
      descripcion === null ||
      cantidad === null ||
      precioUni === null
    ) {
      continue;
    }

    items.push({
      numItem,
      tipoItem,
      numeroDocumento: getOptionalString(entry, 'numeroDocumento', path, errors),
      cantidad,
      codigo: getOptionalString(entry, 'codigo', path, errors),
      codTributo: getOptionalString(entry, 'codTributo', path, errors),
      uniMedida,
      descripcion,
      precioUni,
      montoDescu: getDecimalOrZero(entry, 'montoDescu', path, errors),
      ventaNoSuj: getDecimalOrZero(entry, 'ventaNoSuj', path, errors),
      ventaExenta: getDecimalOrZero(entry, 'ventaExenta', path, errors),
      ventaGravada: getDecimalOrZero(entry, 'ventaGravada', path, errors),
      tributos: parseItemTributos(entry, path, errors),
      psv: getDecimalOrZero(entry, 'psv', path, errors),
      noGravado: getDecimalOrZero(entry, 'noGravado', path, errors),
    });
  }

  // Un CCF sin ítems válidos no sirve para el libro: sus totales no se pueden auditar.
  return items.length > 0 ? items : null;
}

function parseTaxes(resumen: Record<string, unknown>, errors: DteErrorCollector): ParsedTax[] {
  const path = 'resumen.tributos';
  const raw = getOptionalArray(resumen, 'tributos', 'resumen', errors);
  const taxes: ParsedTax[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      errors.add(`${path}[${i}]`, 'se esperaba un objeto');
      continue;
    }
    const codigo = getRequiredString(entry, 'codigo', `${path}[${i}]`, errors);
    const valor = getRequiredDecimal(entry, 'valor', `${path}[${i}]`, errors);
    if (codigo === null || valor === null) continue;

    // La tabla hija es única por [documentId, codigo]: un tributo repetido en el
    // JSON rompería el insert, así que se consolida sumando aquí.
    if (seen.has(codigo)) {
      const existing = taxes.find((tax) => tax.codigo === codigo);
      if (existing) existing.valor = existing.valor.plus(valor);
      continue;
    }
    seen.add(codigo);
    taxes.push({
      codigo,
      descripcion: getOptionalString(entry, 'descripcion', `${path}[${i}]`, errors) ?? '',
      valor,
    });
  }

  return taxes;
}

function parsePayments(
  resumen: Record<string, unknown>,
  errors: DteErrorCollector,
): ParsedPayment[] {
  const path = 'resumen.pagos';
  const raw = getOptionalArray(resumen, 'pagos', 'resumen', errors);
  const payments: ParsedPayment[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      errors.add(`${path}[${i}]`, 'se esperaba un objeto');
      continue;
    }
    const codigo = getRequiredString(entry, 'codigo', `${path}[${i}]`, errors);
    const montoPago = getRequiredDecimal(entry, 'montoPago', `${path}[${i}]`, errors);
    if (codigo === null || montoPago === null) continue;

    payments.push({
      position: i,
      codigo,
      montoPago,
      referencia: getOptionalString(entry, 'referencia', `${path}[${i}]`, errors),
      plazo: getOptionalString(entry, 'plazo', `${path}[${i}]`, errors),
      periodo: getOptionalInt(entry, 'periodo', `${path}[${i}]`, errors),
    });
  }

  return payments;
}

/** Valor del tributo IVA 13 % — columna N del Anexo 3. Cero si no aparece. */
function findIvaCreditoFiscal(taxes: ParsedTax[]): Prisma.Decimal {
  const iva = taxes.find((tax) => tax.codigo === TRIBUTO_IVA);
  return iva ? iva.valor : new Prisma.Decimal(0);
}

function parseResumen(
  obj: Record<string, unknown>,
  extension: Record<string, unknown> | null,
  taxes: ParsedTax[],
  errors: DteErrorCollector,
): ParsedResumen | null {
  const path = 'resumen';
  const totalGravada = getRequiredDecimal(obj, 'totalGravada', path, errors);
  const montoTotalOperacion = getRequiredDecimal(obj, 'montoTotalOperacion', path, errors);
  const totalPagar = getRequiredDecimal(obj, 'totalPagar', path, errors);
  const totalLetras = getRequiredString(obj, 'totalLetras', path, errors);
  const condicionOperacion = getRequiredInt(obj, 'condicionOperacion', path, errors);

  if (
    totalGravada === null ||
    montoTotalOperacion === null ||
    totalPagar === null ||
    totalLetras === null ||
    condicionOperacion === null
  ) {
    return null;
  }

  // `observaciones` vive en resumen (v4) o dentro de extension (v3).
  const observaciones =
    getOptionalString(obj, 'observaciones', path, errors) ??
    (extension === null
      ? null
      : getOptionalString(extension, 'observaciones', 'extension', errors));

  return {
    totalNoSuj: getDecimalOrZero(obj, 'totalNoSuj', path, errors),
    totalExenta: getDecimalOrZero(obj, 'totalExenta', path, errors),
    totalGravada,
    subTotalVentas: getDecimalOrZero(obj, 'subTotalVentas', path, errors),
    descuNoSuj: getDecimalOrZero(obj, 'descuNoSuj', path, errors),
    descuExenta: getDecimalOrZero(obj, 'descuExenta', path, errors),
    descuGravada: getDecimalOrZero(obj, 'descuGravada', path, errors),
    porcentajeDescuento: getDecimalOrZero(obj, 'porcentajeDescuento', path, errors),
    totalDescu: getDecimalOrZero(obj, 'totalDescu', path, errors),
    subTotal: getDecimalOrZero(obj, 'subTotal', path, errors),
    // Alias v3/v4 (§3.2): los campos de retención y percepción faltan seguido y
    // su ausencia significa cero, no error.
    ivaRetenido: getAliasedDecimalOrZero(obj, ALIAS_IVA_RETENIDO, path, errors),
    ivaPercibido: getAliasedDecimalOrZero(obj, ALIAS_IVA_PERCIBIDO, path, errors),
    retencionRenta: getAliasedDecimalOrZero(obj, ALIAS_RETENCION_RENTA, path, errors),
    ivaCreditoFiscal: findIvaCreditoFiscal(taxes),
    montoTotalOperacion,
    totalNoGravado: getDecimalOrZero(obj, 'totalNoGravado', path, errors),
    totalPagar,
    saldoFavor: getDecimalOrZero(obj, 'saldoFavor', path, errors),
    totalLetras,
    condicionOperacion,
    numPagoElectronico: getAliasedOptionalString(obj, ['numPagoElectronico'], path, errors),
    observaciones,
  };
}

function buildPassthrough(
  root: Record<string, unknown>,
  errors: DteErrorCollector,
): ParsedPassthrough {
  return {
    selloRecibido: getOptionalString(root, 'selloRecibido', '', errors),
    documentoRelacionado: getRawSection(root, 'documentoRelacionado'),
    otrosDocumentos: getRawSection(root, 'otrosDocumentos'),
    ventaTercero: getRawSection(root, 'ventaTercero'),
    extension: getRawSection(root, 'extension'),
    apendice: getRawSection(root, 'apendice'),
  };
}

/**
 * Lee `identificacion` de forma defensiva para poder clasificar el archivo
 * (tipo, versión, código de generación) incluso cuando el resto está roto.
 */
function peekIdentificacion(root: Record<string, unknown>): {
  version: number | null;
  tipoDte: string | null;
  codigoGeneracion: string | null;
} {
  const identificacion = readOwn(root, 'identificacion');
  if (!isPlainObject(identificacion)) {
    return { version: null, tipoDte: null, codigoGeneracion: null };
  }
  const version = readOwn(identificacion, 'version');
  const tipoDte = readOwn(identificacion, 'tipoDte');
  const codigoGeneracion = readOwn(identificacion, 'codigoGeneracion');
  return {
    version: typeof version === 'number' && Number.isInteger(version) ? version : null,
    tipoDte: typeof tipoDte === 'string' ? tipoDte : null,
    codigoGeneracion:
      typeof codigoGeneracion === 'string' && codigoGeneracion.trim().length > 0
        ? codigoGeneracion.trim()
        : null,
  };
}

/**
 * Parsea un DTE ya deserializado (el `JSON.parse` lo hace quien lee el archivo).
 *
 * El orden de las decisiones importa y es deliberado:
 * 1. ¿Es siquiera un sobre DTE? → `not-dte`.
 * 2. ¿La versión está soportada? → `unsupported-version` (no se intenta adivinar).
 * 3. ¿Es un Comprobante de Crédito Fiscal? → si no, `ignored-type` (barato, y
 *    deja registrado el tipo para habilitar notas de crédito/débito después).
 * 4. Recién ahí se valida el contenido completo → `parsed` o `invalid`.
 */
export function parseDte(raw: unknown): ParseOutcome {
  if (!isPlainObject(raw)) {
    return { kind: 'not-dte' };
  }

  const peek = peekIdentificacion(raw);

  // Un sobre DTE tiene identificacion + emisor + receptor. Sin eso no vale la
  // pena reportar errores campo por campo: no es el tipo de archivo esperado.
  if (
    peek.version === null &&
    peek.tipoDte === null &&
    !isPlainObject(readOwn(raw, 'identificacion'))
  ) {
    return { kind: 'not-dte' };
  }

  if (peek.version === null || !isSupportedVersion(peek.version)) {
    return {
      kind: 'unsupported-version',
      version: peek.version,
      tipoDte: peek.tipoDte,
      codigoGeneracion: peek.codigoGeneracion,
    };
  }

  if (peek.tipoDte !== TIPO_DTE_CCF) {
    if (peek.tipoDte === null) {
      return {
        kind: 'invalid',
        errors: [{ path: 'identificacion.tipoDte', message: 'campo obligatorio ausente' }],
        tipoDte: null,
        version: peek.version,
        codigoGeneracion: peek.codigoGeneracion,
      };
    }
    return {
      kind: 'ignored-type',
      tipoDte: peek.tipoDte,
      version: peek.version,
      codigoGeneracion: peek.codigoGeneracion,
    };
  }

  const errors = new DteErrorCollector();

  const identificacionObj = getRequiredObject(raw, 'identificacion', '', errors);
  const emisorObj = getRequiredObject(raw, 'emisor', '', errors);
  const receptorObj = getRequiredObject(raw, 'receptor', '', errors);
  const resumenObj = getRequiredObject(raw, 'resumen', '', errors);
  const cuerpoRaw = getRequiredArray(raw, 'cuerpoDocumento', '', errors);
  const extensionObj = getOptionalObject(raw, 'extension', '', errors);

  const identificacion =
    identificacionObj === null ? null : parseIdentificacion(identificacionObj, errors);
  const emisor = emisorObj === null ? null : parseParty(emisorObj, 'emisor', errors);
  const emisorExtras = emisorObj === null ? null : parseEmisorExtras(emisorObj, errors);
  const receptor = receptorObj === null ? null : parseParty(receptorObj, 'receptor', errors);
  const items = cuerpoRaw === null ? null : parseItems(cuerpoRaw, errors);
  const taxes = resumenObj === null ? [] : parseTaxes(resumenObj, errors);
  const payments = resumenObj === null ? [] : parsePayments(resumenObj, errors);
  const resumen =
    resumenObj === null ? null : parseResumen(resumenObj, extensionObj, taxes, errors);

  if (
    identificacion === null ||
    emisor === null ||
    emisorExtras === null ||
    receptor === null ||
    resumen === null ||
    items === null ||
    errors.hasErrors
  ) {
    return {
      kind: 'invalid',
      errors: errors.hasErrors
        ? errors.list()
        : [{ path: '', message: 'el documento no pudo normalizarse' }],
      tipoDte: peek.tipoDte,
      version: peek.version,
      codigoGeneracion: peek.codigoGeneracion,
    };
  }

  return {
    kind: 'parsed',
    dte: {
      identificacion,
      emisor,
      emisorExtras,
      receptor,
      resumen,
      items,
      taxes,
      payments,
      passthrough: buildPassthrough(raw, errors),
    },
  };
}
