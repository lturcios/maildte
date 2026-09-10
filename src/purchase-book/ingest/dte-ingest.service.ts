import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { readFile, stat } from 'fs/promises';
import { DteParseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../../prisma/prisma-errors';
import { StorageService } from '../../storage/storage.service';
import { AppConfigService } from '../../config/app-config.service';
import { parseDte, PARSER_VERSION } from '../parser/dte-parser';
import { resolveCanonicalKey } from '../identity/canonical-key';
import { splitSupplierId } from '../anexo/split-supplier-id';
import { ParsedCcf, ParseOutcome } from '../parser/dte-parser.types';

/** Estados terminales: no se re-parsea salvo que el job pida `force`. */
const TERMINAL_STATUSES: DteParseStatus[] = [
  DteParseStatus.PARSEADO,
  DteParseStatus.DUPLICADO,
  DteParseStatus.IGNORADO_TIPO,
];

/** Tope de caracteres de `errorDetail`: el ledger no es un volcado de diagnóstico. */
const ERROR_DETAIL_MAX = 1000;

export interface IngestOptions {
  force?: boolean;
}

interface AttachmentRow {
  id: string;
  emailId: string;
  relativePath: string;
  sizeBytes: number;
  email: { accountId: string };
}

/**
 * Ingesta de un adjunto JSON de DTE al libro de compras (Addendum 10, §6.4).
 *
 * Contrato de errores, que es lo que hace que la cola no se llene de reintentos
 * inútiles:
 *
 * - Fallo DETERMINISTA (JSON roto, no es un DTE, tipo ignorado, archivo faltante,
 *   archivo enorme): escribe el ledger y RETORNA normalmente. Reintentarlo daría
 *   el mismo resultado.
 * - Fallo de INFRAESTRUCTURA (base de datos caída, error de disco distinto de
 *   ENOENT): PROPAGA, para que BullMQ reintente con backoff.
 */
@Injectable()
export class DteIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DteIngestService.name);
  }

  /**
   * Procesa un adjunto y devuelve el estado con el que quedó registrado, o
   * `null` si no había nada que hacer (adjunto ajeno, tenant inactivo, PDF, o
   * ya procesado con la versión actual del parser).
   */
  async ingestAttachment(
    tenantId: string,
    attachmentId: string,
    options: IngestOptions = {},
  ): Promise<DteParseStatus | null> {
    const force = options.force ?? false;
    const logCtx = { tenantId, attachmentId };

    // El tenant se revalida en tiempo de ejecución, no al encolar: entre el
    // encolado y el consumo pudo suspenderse (skill tenancy, regla 14).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, status: true },
    });
    if (!tenant || tenant.status !== 'ACTIVO') {
      this.logger.info(logCtx, 'Tenant inexistente o no activo, se omite el parseo');
      return null;
    }

    const attachment = await this.loadAttachment(tenantId, attachmentId);
    if (!attachment) {
      this.logger.warn(logCtx, 'Adjunto JSON no encontrado para este tenant, se omite');
      return null;
    }

    if (!force && (await this.hasTerminalResult(tenantId, attachmentId))) {
      return null;
    }

    // Primer control de tamaño con el dato de la base: evita tocar el disco.
    if (attachment.sizeBytes > this.config.dteMaxJsonBytes) {
      return this.recordFailure(
        tenantId,
        attachmentId,
        DteParseStatus.ARCHIVO_DEMASIADO_GRANDE,
        `El archivo mide ${attachment.sizeBytes} bytes y el máximo es ${this.config.dteMaxJsonBytes}`,
      );
    }

    const content = await this.readJsonFile(tenant.slug, attachment, logCtx);
    if (content.status !== null) {
      return this.recordFailure(tenantId, attachmentId, content.status, content.detail);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content.text);
    } catch (err) {
      return this.recordFailure(
        tenantId,
        attachmentId,
        DteParseStatus.JSON_INVALIDO,
        this.describeError(err),
      );
    }

    const outcome = parseDte(raw);
    if (outcome.kind !== 'parsed') {
      return this.recordParseOutcome(tenantId, attachmentId, outcome);
    }

    return this.persist(tenantId, attachmentId, attachment, outcome.dte, raw);
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  private async loadAttachment(
    tenantId: string,
    attachmentId: string,
  ): Promise<AttachmentRow | null> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.attachment.findFirst({
        // tenantId repetido en el where aunque RLS ya filtre: defensa en profundidad.
        where: { id: attachmentId, tenantId, fileType: 'JSON' },
        select: {
          id: true,
          emailId: true,
          relativePath: true,
          sizeBytes: true,
          email: { select: { accountId: true } },
        },
      }),
    );
  }

  private async hasTerminalResult(tenantId: string, attachmentId: string): Promise<boolean> {
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.dteParseResult.findFirst({
        where: { attachmentId, tenantId },
        select: { status: true, parserVersion: true },
      }),
    );
    return (
      existing !== null &&
      existing.parserVersion === PARSER_VERSION &&
      TERMINAL_STATUSES.includes(existing.status)
    );
  }

  /**
   * Lee el archivo del storage del tenant. `status` distinto de `null` significa
   * que hay que registrar ese fallo en el ledger y no seguir.
   */
  private async readJsonFile(
    tenantSlug: string,
    attachment: AttachmentRow,
    logCtx: Record<string, unknown>,
  ): Promise<{ status: DteParseStatus | null; detail: string; text: string }> {
    let absolutePath: string;
    try {
      // Único camino permitido al disco: valida que la ruta caiga dentro del
      // área del tenant. El slug sale del tenant, nunca del adjunto.
      absolutePath = this.storage.resolveSafe(tenantSlug, attachment.relativePath);
    } catch (err) {
      // Una ruta fuera del área es una anomalía de datos, no un fallo transitorio:
      // se registra y no se reintenta.
      this.logger.error({ ...logCtx, err }, 'Ruta de almacenamiento inválida');
      return { status: DteParseStatus.ERROR, detail: this.describeError(err), text: '' };
    }

    try {
      // Segundo control de tamaño contra el archivo real: la fila puede estar
      // desactualizada respecto de lo que hay en disco.
      const stats = await stat(absolutePath);
      if (stats.size > this.config.dteMaxJsonBytes) {
        return {
          status: DteParseStatus.ARCHIVO_DEMASIADO_GRANDE,
          detail: `El archivo en disco mide ${stats.size} bytes y el máximo es ${this.config.dteMaxJsonBytes}`,
          text: '',
        };
      }
      const text = await readFile(absolutePath, 'utf8');
      return { status: null, detail: '', text };
    } catch (err) {
      if (this.isMissingFile(err)) {
        return {
          status: DteParseStatus.ARCHIVO_FALTANTE,
          detail: 'El archivo ya no existe en el almacenamiento',
          text: '',
        };
      }
      // Cualquier otro error de disco sí es transitorio: que reintente la cola.
      throw err;
    }
  }

  private isMissingFile(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    );
  }

  // -------------------------------------------------------------------------
  // Persistencia
  // -------------------------------------------------------------------------

  /**
   * Escribe partes, documento e hijos en UNA transacción con contexto de tenant.
   * Si algo falla a mitad, no queda un documento sin ítems.
   */
  private async persist(
    tenantId: string,
    attachmentId: string,
    attachment: AttachmentRow,
    dte: ParsedCcf,
    raw: unknown,
  ): Promise<DteParseStatus> {
    const { identificacion, emisor, emisorExtras, receptor, resumen, passthrough } = dte;

    try {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const emisorParty = await this.upsertParty(tx, tenantId, dte.emisor, 'EMISOR');
        const receptorParty = await this.upsertParty(tx, tenantId, dte.receptor, 'RECEPTOR');

        const scalars = {
          emailId: attachment.emailId,
          accountId: attachment.email.accountId,
          version: identificacion.version,
          ambiente: identificacion.ambiente,
          tipoDte: identificacion.tipoDte,
          numeroControl: identificacion.numeroControl,
          codigoGeneracion: identificacion.codigoGeneracion,
          tipoModelo: identificacion.tipoModelo,
          tipoOperacion: identificacion.tipoOperacion,
          tipoContingencia: identificacion.tipoContingencia,
          motivoContin: identificacion.motivoContin,
          fecEmi: identificacion.fecEmi,
          horEmi: identificacion.horEmi,
          tipoMoneda: identificacion.tipoMoneda,
          emisorId: emisorParty,
          emisorNit: emisor.nit,
          emisorNrc: emisor.nrc,
          emisorNombre: emisor.nombre,
          emisorNombreComercial: emisor.nombreComercial,
          emisorCodActividad: emisor.codActividad,
          emisorTipoEstablecimiento: emisorExtras.tipoEstablecimiento,
          emisorCodEstable: emisorExtras.codEstable,
          emisorCodPuntoVenta: emisorExtras.codPuntoVenta,
          receptorId: receptorParty,
          receptorNit: receptor.nit,
          receptorNrc: receptor.nrc,
          receptorNombre: receptor.nombre,
          receptorNombreComercial: receptor.nombreComercial,
          // La actividad del receptor en `DteParty` la pisa el upsert de cada
          // documento: sin este snapshot el histórico por actividad no existe
          // (Addendum 11, §1.2).
          receptorCodActividad: receptor.codActividad,
          receptorDescActividad: receptor.descActividad,
          ...resumen,
          selloRecibido: passthrough.selloRecibido,
          documentoRelacionado: this.toJson(passthrough.documentoRelacionado),
          otrosDocumentos: this.toJson(passthrough.otrosDocumentos),
          ventaTercero: this.toJson(passthrough.ventaTercero),
          extension: this.toJson(passthrough.extension),
          apendice: this.toJson(passthrough.apendice),
          rawJson: raw as Prisma.InputJsonValue,
          parserVersion: PARSER_VERSION,
        };

        // Que el documento exista NO depende de `force`: depende de si este
        // adjunto ya produjo uno. `force` gobierna el early-exit de
        // `hasTerminalResult`, no cómo se escribe.
        //
        // Buscarlo solo con `force` rompía el reprocesamiento por versión de
        // parser: `mode=failed` encola los adjuntos con `parserVersion` anterior
        // SIN force (`scripts/backfill-purchase-book.ts` solo fuerza en `all`),
        // así que un documento ya PARSEADO se iba por `create` contra un
        // `attachmentId` único y moría con P2002 — que además no es un
        // duplicado entre buzones, así que `findCanonical` devolvía null y el
        // error se propagaba. El adjunto se reintentaba 3 veces y quedaba con la
        // versión vieja. Verificado en el e2e, que cubre justamente ese camino.
        const existing = await tx.purchaseDocument.findFirst({
          where: { attachmentId, tenantId },
          select: { id: true },
        });

        let documentId: string;
        if (existing) {
          // Re-parseo: se reemplazan escalares e hijos, pero NO los campos
          // anexo* ni la auditoría de clasificación. El criterio contable del
          // usuario sobrevive a cualquier corrección del parser.
          await tx.purchaseDocument.update({ where: { id: existing.id }, data: scalars });
          await tx.purchaseDocumentItem.deleteMany({ where: { documentId: existing.id } });
          await tx.purchaseDocumentTax.deleteMany({ where: { documentId: existing.id } });
          await tx.purchaseDocumentPayment.deleteMany({ where: { documentId: existing.id } });
          documentId = existing.id;
          await this.createChildren(tx, tenantId, documentId, dte);
        } else {
          const created = await tx.purchaseDocument.create({
            data: { tenantId, attachmentId, ...scalars },
            select: { id: true },
          });
          documentId = created.id;
          await this.createChildren(tx, tenantId, documentId, dte);
        }

        await this.upsertLedger(tx, tenantId, attachmentId, {
          status: DteParseStatus.PARSEADO,
          tipoDte: identificacion.tipoDte,
          version: identificacion.version,
          codigoGeneracion: identificacion.codigoGeneracion,
          documentId,
          errorDetail: null,
        });
      });

      this.logger.debug(
        { tenantId, attachmentId, codigoGeneracion: identificacion.codigoGeneracion },
        'DTE parseado e incorporado al libro de compras',
      );
      return DteParseStatus.PARSEADO;
    } catch (err) {
      // El mismo DTE puede llegar a dos buzones del tenant. El primero gana y
      // es el canónico; el segundo queda apuntando a él.
      //
      // No se compara contra el NOMBRE del constraint: dentro de una transacción
      // con RLS, Postgres no expone `meta.target` y Prisma reporta
      // "Unique constraint failed on the (not available)". Verificado en el e2e.
      // Por eso se detecta el P2002 genérico y se confirma la causa consultando
      // el documento canónico, que además es el dato que hay que registrar.
      if (isPrismaUniqueViolation(err)) {
        const canonical = await this.findCanonical(
          tenantId,
          identificacion.codigoGeneracion,
          attachmentId,
        );
        if (canonical) {
          return this.recordDuplicate(tenantId, attachmentId, identificacion.codigoGeneracion, {
            tipoDte: identificacion.tipoDte,
            version: identificacion.version,
            documentId: canonical,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Documento ya registrado para ese código de generación en OTRO adjunto.
   * Devuelve `null` si no existe o si es el propio adjunto, en cuyo caso la
   * violación única vino de otra restricción y hay que propagar el error.
   */
  private async findCanonical(
    tenantId: string,
    codigoGeneracion: string,
    attachmentId: string,
  ): Promise<string | null> {
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.purchaseDocument.findFirst({
        where: { tenantId, codigoGeneracion },
        select: { id: true, attachmentId: true },
      }),
    );
    if (!existing || existing.attachmentId === attachmentId) return null;
    return existing.id;
  }

  /**
   * Resuelve la parte del DTE y devuelve su id, creándola si no existía.
   *
   * Addendum 11, fase 2: la identidad la decide la clave canónica (NRC
   * normalizado > NIT-14 > DUI-9), no el identificador crudo del documento.
   * Unos proveedores referencian al mismo contribuyente con el NIT de 14
   * dígitos y otros con el homologado al DUI, de 9: buscando por `nit`, el mismo
   * contribuyente terminaba como dos filas y el Anexo 3 de una dejaba las
   * compras de la otra fuera de la declaración.
   *
   * **`nit` no se escribe nunca en un update.** El `@@unique([tenantId, nit])`
   * sigue vigente hasta que el script de fusión (§4 del addendum) elimine los
   * duplicados del histórico: escribirle a la parte `022560911` el nit
   * `11022205761034` la haría chocar contra su hermana y la ingesta moriría con
   * un P2002. El identificador queda como se vio la primera vez; el segundo, si
   * mide 9 dígitos, se guarda en `dui`. Los demás identificadores (`dui`, `nrc`)
   * solo llenan huecos: completan lo que está vacío y no reemplazan lo visto.
   *
   * **Carrera conocida y aceptada.** Mientras no exista
   * `@@unique([tenantId, canonicalKey])` —que llega al cierre de la fase,
   * cuando ya no queden duplicados— dos ingestas concurrentes del mismo
   * contribuyente nuevo, con identificadores distintos, pueden crear dos filas.
   * El `@@unique([tenantId, nit])` vigente cubre el caso frecuente (las dos
   * ingestas traen el mismo identificador) y el script de fusión limpia el
   * resto. No se resuelve con locks: sería un lock por parte y por documento en
   * el camino caliente de la ingesta para una ventana que la fase cierra sola.
   */
  private async upsertParty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    party: ParsedCcf['emisor'],
    role: 'EMISOR' | 'RECEPTOR',
  ): Promise<string> {
    const canonicalKey = resolveCanonicalKey(party);
    // Misma definición de "este identificador es un DUI" que usa la regla E/P
    // del anexo: la longitud del número sin separadores. Cadena vacía cuando no
    // mide 9 dígitos; una segunda definición acá sería la forma garantizada de
    // que la ingesta y el export no coincidan en qué es un DUI.
    const incomingDui = splitSupplierId(party.nit).dui || null;

    // Campos descriptivos: se refrescan con cada documento, como hasta ahora.
    const descriptive = {
      nombre: party.nombre,
      nombreComercial: party.nombreComercial,
      codActividad: party.codActividad,
      descActividad: party.descActividad,
      departamento: party.departamento,
      municipio: party.municipio,
      distrito: party.distrito,
      complemento: party.complemento,
      telefono: party.telefono,
      correo: party.correo,
    };
    // Los flags se acumulan con OR: una parte puede ser emisor en un documento y
    // receptor en otro, y ninguno de los dos roles se pierde al actualizar.
    const roleFlags = role === 'EMISOR' ? { seenAsEmisor: true } : { seenAsReceptor: true };

    const existing = await this.findParty(tx, tenantId, canonicalKey, party.nit);

    if (existing === null) {
      const created = await tx.dteParty.create({
        data: {
          tenantId,
          nit: party.nit,
          dui: incomingDui,
          nrc: party.nrc,
          canonicalKey,
          ...descriptive,
          ...roleFlags,
        },
        select: { id: true },
      });
      return created.id;
    }

    await tx.dteParty.update({
      where: { id: existing.id },
      data: {
        ...descriptive,
        ...roleFlags,
        // Una clave nula significa "este documento no permitió resolverla", no
        // "esta parte no tiene": no se borra la que ya estaba calculada.
        ...(canonicalKey !== null ? { canonicalKey } : {}),
        ...(!existing.dui && incomingDui !== null ? { dui: incomingDui } : {}),
        ...(!existing.nrc && party.nrc ? { nrc: party.nrc } : {}),
      },
    });
    return existing.id;
  }

  /**
   * Busca la parte primero por clave canónica y, si no la encuentra, por el
   * identificador del documento.
   *
   * El segundo paso no es decorativo ni es solo el camino de una clave nula: una
   * parte creada desde un DTE sin NRC quedó con la clave del NIT, y el primer
   * documento que sí traiga NRC resuelve otra clave. Sin caer al `nit` se
   * intentaría crear una fila que choca contra el `@@unique([tenantId, nit])`
   * vigente y mata la ingesta con un P2002.
   */
  private async findParty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    canonicalKey: string | null,
    nit: string,
  ): Promise<{ id: string; dui: string | null; nrc: string | null } | null> {
    if (canonicalKey !== null) {
      const byCanonicalKey = await tx.dteParty.findFirst({
        // tenantId repetido en el where aunque RLS ya filtre: defensa en profundidad.
        where: { tenantId, canonicalKey },
        select: { id: true, dui: true, nrc: true },
        // Con los duplicados del histórico todavía sin fusionar puede haber más
        // de una fila con la misma clave. Se toma siempre la más antigua: un
        // criterio estable evita que la ingesta alterne entre hermanas documento
        // a documento. Cuál queda como canónica lo decide el script de fusión.
        orderBy: { createdAt: 'asc' },
      });
      if (byCanonicalKey !== null) return byCanonicalKey;
    }

    return tx.dteParty.findUnique({
      where: { tenantId_nit: { tenantId, nit } },
      select: { id: true, dui: true, nrc: true },
    });
  }

  private async createChildren(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentId: string,
    dte: ParsedCcf,
  ): Promise<void> {
    await tx.purchaseDocumentItem.createMany({
      data: dte.items.map((item) => ({ tenantId, documentId, ...item })),
    });
    if (dte.taxes.length > 0) {
      await tx.purchaseDocumentTax.createMany({
        data: dte.taxes.map((tax) => ({ tenantId, documentId, ...tax })),
      });
    }
    if (dte.payments.length > 0) {
      await tx.purchaseDocumentPayment.createMany({
        data: dte.payments.map((payment) => ({ tenantId, documentId, ...payment })),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  /** Traduce el resultado no exitoso del parser al estado del ledger. */
  private async recordParseOutcome(
    tenantId: string,
    attachmentId: string,
    outcome: Exclude<ParseOutcome, { kind: 'parsed' }>,
  ): Promise<DteParseStatus> {
    switch (outcome.kind) {
      case 'not-dte':
        return this.recordFailure(
          tenantId,
          attachmentId,
          DteParseStatus.NO_ES_DTE,
          'El archivo es JSON válido pero no tiene la estructura de un DTE',
        );
      case 'unsupported-version':
        return this.recordFailure(
          tenantId,
          attachmentId,
          DteParseStatus.VERSION_NO_SOPORTADA,
          `Versión de esquema no soportada: ${outcome.version ?? 'desconocida'}`,
          {
            tipoDte: outcome.tipoDte,
            version: outcome.version,
            codigoGeneracion: outcome.codigoGeneracion,
          },
        );
      case 'ignored-type':
        return this.recordFailure(
          tenantId,
          attachmentId,
          DteParseStatus.IGNORADO_TIPO,
          `El libro de compras solo incorpora tipoDte 03; este documento es ${outcome.tipoDte}`,
          {
            tipoDte: outcome.tipoDte,
            version: outcome.version,
            codigoGeneracion: outcome.codigoGeneracion,
          },
        );
      case 'invalid':
        return this.recordFailure(
          tenantId,
          attachmentId,
          DteParseStatus.ERROR,
          outcome.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '),
          {
            tipoDte: outcome.tipoDte,
            version: outcome.version,
            codigoGeneracion: outcome.codigoGeneracion,
          },
        );
    }
  }

  private async recordFailure(
    tenantId: string,
    attachmentId: string,
    status: DteParseStatus,
    detail: string,
    meta: {
      tipoDte?: string | null;
      version?: number | null;
      codigoGeneracion?: string | null;
    } = {},
  ): Promise<DteParseStatus> {
    await this.prisma.withTenant(tenantId, (tx) =>
      this.upsertLedger(tx, tenantId, attachmentId, {
        status,
        tipoDte: meta.tipoDte ?? null,
        version: meta.version ?? null,
        codigoGeneracion: meta.codigoGeneracion ?? null,
        documentId: null,
        errorDetail: detail.slice(0, ERROR_DETAIL_MAX),
      }),
    );
    this.logger.debug({ tenantId, attachmentId, status }, 'DTE no incorporado al libro');
    return status;
  }

  private async recordDuplicate(
    tenantId: string,
    attachmentId: string,
    codigoGeneracion: string,
    meta: { tipoDte: string; version: number; documentId: string },
  ): Promise<DteParseStatus> {
    await this.prisma.withTenant(tenantId, (tx) =>
      this.upsertLedger(tx, tenantId, attachmentId, {
        status: DteParseStatus.DUPLICADO,
        tipoDte: meta.tipoDte,
        version: meta.version,
        codigoGeneracion,
        documentId: meta.documentId,
        errorDetail: 'El documento ya estaba registrado desde otro adjunto del mismo tenant',
      }),
    );
    this.logger.debug(
      { tenantId, attachmentId, codigoGeneracion },
      'DTE duplicado: ya existía en el libro de compras',
    );
    return DteParseStatus.DUPLICADO;
  }

  private async upsertLedger(
    tx: Prisma.TransactionClient,
    tenantId: string,
    attachmentId: string,
    data: {
      status: DteParseStatus;
      tipoDte: string | null;
      version: number | null;
      codigoGeneracion: string | null;
      documentId: string | null;
      errorDetail: string | null;
    },
  ): Promise<void> {
    await tx.dteParseResult.upsert({
      where: { attachmentId },
      create: { tenantId, attachmentId, ...data, parserVersion: PARSER_VERSION },
      update: { ...data, parserVersion: PARSER_VERSION, parsedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value === null || value === undefined
      ? Prisma.JsonNull
      : (value as Prisma.InputJsonValue);
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
