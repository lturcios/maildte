import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { readFile, stat } from 'fs/promises';
import { DteParseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../../prisma/prisma-errors';
import { StorageService } from '../../storage/storage.service';
import { AppConfigService } from '../../config/app-config.service';
import { parseDte, PARSER_VERSION } from '../parser/dte-parser';
import { CanonicalKeyResolution, resolveCanonicalKeyWithSource } from '../identity/canonical-key';
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
   * sigue vigente —y se conserva junto al de la clave canónica, ver el
   * esquema—: escribirle a la parte `022560911` el nit `11022205761034` la haría
   * chocar contra cualquier otra fila que ya tuviera ese identificador y la
   * ingesta moriría con un P2002. El identificador queda como se vio la primera
   * vez; el segundo, si mide 9 dígitos, se guarda en `dui`. Los demás
   * identificadores (`dui`, `nrc`) solo llenan huecos: completan lo que está
   * vacío y no reemplazan lo visto.
   *
   * **La `canonicalKey` de una parte que ya la tiene solo la pisa el NRC.** Ver
   * `canonicalKeyUpdate()`: es lo que impide que un documento sin NRC deshaga
   * una fusión ya aplicada.
   *
   * **Concurrencia.** Con el `@@unique([tenantId, canonicalKey])` en su lugar,
   * dos ingestas simultáneas del mismo contribuyente nuevo ya no pueden crear
   * dos filas: la segunda muere con un P2002 que se propaga, BullMQ la reintenta
   * y en el reintento encuentra la parte y actualiza. Antes del constraint esa
   * carrera dejaba el contribuyente partido y había que fusionarlo a mano.
   */
  private async upsertParty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    party: ParsedCcf['emisor'],
    role: 'EMISOR' | 'RECEPTOR',
  ): Promise<string> {
    const resolved = resolveCanonicalKeyWithSource(party);
    const canonicalKey = resolved?.key ?? null;
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

    const existing = await this.findParty(tx, tenantId, canonicalKey, party.nit, incomingDui);

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
        ...this.canonicalKeyUpdate(existing.canonicalKey, resolved),
        ...(!existing.dui && incomingDui !== null ? { dui: incomingDui } : {}),
        ...(!existing.nrc && party.nrc ? { nrc: party.nrc } : {}),
      },
    });
    return existing.id;
  }

  /**
   * Decide si la clave canónica entrante puede escribirse sobre la que la parte
   * ya tiene. Devuelve el fragmento del `data` del update: vacío significa "no
   * se toca".
   *
   * Tres casos, y el orden importa:
   *
   * 1. **La entrante es nula** → no se toca. Una clave nula significa "este
   *    documento no permitió resolverla", no "esta parte no tiene": borrar la ya
   *    calculada dejaría a la parte fuera del constraint y fuera de la búsqueda
   *    por clave.
   * 2. **La parte no tiene clave** → se escribe la entrante, sea de la rama que
   *    sea. Es la única forma de que una parte vieja o creada desde un documento
   *    incompleto entre a la identidad canónica.
   * 3. **La parte ya tiene clave** → solo la pisa una clave derivada del **NRC**,
   *    que es el nivel más alto de la cascada. Esto es lo que hace que el
   *    upgrade siga funcionando (una parte con la clave del NIT recibe la del
   *    NRC en cuanto un documento lo trae) sin que la degradación sea posible.
   *
   * **Por qué el caso 3 es una regla y no un detalle.** La parte canónica que
   * dejó el script de fusión tiene la clave del NRC (`1435153`) y, por la
   * fusión, también el `dui` de su hermana absorbida (`022560911`). Un proveedor
   * que emita **sin NRC** usando ese identificador de 9 dígitos resuelve la
   * clave `022560911` por la rama `dui`. Sin esta regla, el update le escribiría
   * esa clave a la parte canónica, destruiría la clave buena y desharía la
   * fusión desde adentro — y el histórico quedaría apuntando a una parte cuya
   * identidad cambió sin que nada lo registre.
   */
  private canonicalKeyUpdate(
    existingKey: string | null,
    resolved: CanonicalKeyResolution | null,
  ): { canonicalKey?: string } {
    if (resolved === null) return {};
    if (existingKey === null) return { canonicalKey: resolved.key };
    if (resolved.source === 'nrc') return { canonicalKey: resolved.key };
    return {};
  }

  /**
   * Busca la parte primero por clave canónica y, si no la encuentra, por
   * cualquiera de los identificadores del documento.
   *
   * El segundo paso no es decorativo ni es solo el camino de una clave nula.
   * Cubre dos huecos de la cascada:
   *
   * - Una parte creada desde un DTE **sin NRC** quedó con la clave del NIT, y el
   *   primer documento que sí traiga NRC resuelve otra clave. Sin caer al
   *   identificador se intentaría crear una fila que choca contra el
   *   `@@unique([tenantId, nit])` y mata la ingesta con un P2002.
   * - A la inversa —y este es el que reintroduce el split—: un proveedor que
   *   emite **sin NRC** usando el identificador de 9 dígitos de un contribuyente
   *   ya fusionado resuelve la clave del DUI, que no es la de la parte canónica.
   *   La búsqueda por clave no la encuentra, y la búsqueda por `nit` tampoco
   *   porque esa fila se borró en la fusión: el identificador sobrevive en la
   *   columna `dui` de la canónica. Por eso el fallback mira las **dos**
   *   columnas. Sin esto se crearía una parte nueva y el contribuyente volvería
   *   a partirse — invisible para el script de fusión, que agrupa por clave, y
   *   para la guarda de export, que compara claves.
   *
   * `dui` se compara contra el identificador **normalizado** (solo dígitos),
   * que es como lo escriben esta misma ingesta y el backfill de la migración;
   * `nit` se compara contra el valor crudo, que es como se guardó.
   */
  private async findParty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    canonicalKey: string | null,
    nit: string,
    incomingDui: string | null,
  ): Promise<{
    id: string;
    canonicalKey: string | null;
    dui: string | null;
    nrc: string | null;
  } | null> {
    // Puede haber más de una fila candidata: el UNIQUE de la clave canónica no
    // alcanza al fallback, donde el mismo identificador de 9 dígitos puede ser
    // el `nit` de una parte vieja y el `dui` de la parte que dejó la fusión. Se
    // toma siempre la más antigua: un criterio estable evita que la ingesta
    // alterne entre las dos documento a documento. Cuál queda como canónica lo
    // decide el script de fusión, no el orden de llegada de los DTE.
    const select = { id: true, canonicalKey: true, dui: true, nrc: true } as const;
    const orderBy = { createdAt: 'asc' } as const;

    if (canonicalKey !== null) {
      const byCanonicalKey = await tx.dteParty.findFirst({
        // tenantId repetido en el where aunque RLS ya filtre: defensa en profundidad.
        where: { tenantId, canonicalKey },
        select,
        orderBy,
      });
      if (byCanonicalKey !== null) return byCanonicalKey;
    }

    return tx.dteParty.findFirst({
      where: {
        tenantId,
        OR: incomingDui !== null ? [{ nit }, { dui: incomingDui }] : [{ nit }],
      },
      select,
      orderBy,
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
