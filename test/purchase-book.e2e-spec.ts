import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { DteIngestService } from '../src/purchase-book/ingest/dte-ingest.service';
import { PurchaseBookIngestModule } from '../src/purchase-book/ingest/purchase-book-ingest.module';
import { createSeedClient, seedApiKey, seedTenant, seedUser } from './helpers/tenant-fixtures';
import ccfV3 from '../src/purchase-book/__fixtures__/ccf-v3.json';
import ccfV4 from '../src/purchase-book/__fixtures__/ccf-v4.json';

/**
 * E2E del libro de compras (Addendum 10, §11.2).
 *
 * La ingesta se ejecuta llamando a DteIngestService directamente: es el mismo
 * camino que corre el worker, pero sin depender de que BullMQ entregue el job
 * dentro del tiempo del test. Todo lo demás pasa por HTTP real, con el rol de
 * aplicación y RLS activo.
 */
describe('Libro de compras (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ingest: DteIngestService;

  /** Tenant A: dos cuentas, para poder probar el duplicado entre buzones. */
  let tenantA: { id: string; slug: string };
  let tenantB: { id: string; slug: string };
  let apiKeyA: string;
  let apiKeyB: string;
  let adminTokenA: string;
  let miembroTokenA: string;
  let superadminToken: string;

  let docV3Id: string;
  let docV4Id: string;
  let receptorV3Id: string;
  let receptorV4Id: string;

  /**
   * Los dos DTE de muestra están dirigidos a receptores distintos: es el caso
   * real de un buzón que recibe compras de varios clientes, y el que obliga a
   * que el export del Anexo 3 abarque un solo contribuyente.
   */
  const RECEPTOR_V3_NIT = '12171609731022';
  const RECEPTOR_V4_NIT = '06140203901028';

  const accountA1 = randomUUID();
  const accountA2 = randomUUID();
  const accountB1 = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, PurchaseBookIngestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    ingest = app.get(DteIngestService);
    prisma = createSeedClient();
    await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    rmSync(process.env.STORAGE_ROOT as string, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Escribe el JSON en el storage del tenant y crea correo + adjunto. */
  async function seedDteAttachment(params: {
    tenant: { id: string; slug: string };
    accountId: string;
    folderName: string;
    dte: unknown;
    fileName: string;
  }): Promise<string> {
    const relativePath = join(
      params.tenant.slug,
      params.folderName,
      '2026-05',
      'json',
      params.fileName,
    ).replace(/\\/g, '/');

    const absolutePath = join(process.env.STORAGE_ROOT as string, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const content = JSON.stringify(params.dte);
    writeFileSync(absolutePath, content, 'utf8');

    const email = await prisma.processedEmail.create({
      data: {
        tenantId: params.tenant.id,
        accountId: params.accountId,
        messageId: `<${randomUUID()}@test.local>`,
        uid: Math.floor(Math.random() * 100_000),
        subject: 'DTE recibido',
        senderName: 'Proveedor',
        senderEmail: 'proveedor@test.local',
        recipients: ['compras@test.local'],
        receivedAt: new Date('2026-05-29T10:00:00.000Z'),
        monthFolder: '2026-05',
        attachmentCount: 1,
        status: 'PROCESADO',
      },
    });

    const attachment = await prisma.attachment.create({
      data: {
        tenantId: params.tenant.id,
        emailId: email.id,
        originalName: params.fileName,
        storedName: params.fileName,
        relativePath,
        fileType: 'JSON',
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(content),
        sha256: randomUUID().replace(/-/g, ''),
      },
    });

    return attachment.id;
  }

  async function seedAccount(
    tenant: { id: string },
    id: string,
    folderName: string,
  ): Promise<void> {
    await prisma.emailAccount.create({
      data: {
        id,
        tenantId: tenant.id,
        alias: folderName,
        email: `${folderName}@test.local`,
        folderName,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: `${folderName}@test.local`,
        imapPassEnc: 'x:y:z',
      },
    });
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });
    return res.body.data.accessToken as string;
  }

  async function seedFixtures(): Promise<void> {
    tenantA = await seedTenant(prisma);
    tenantB = await seedTenant(prisma);

    const adminA = await seedUser(prisma, tenantA.id, 'ADMIN');
    const miembroA = await seedUser(prisma, tenantA.id, 'MIEMBRO');
    const superadmin = await seedUser(prisma, null, 'SUPERADMIN');
    await seedUser(prisma, tenantB.id, 'ADMIN');

    apiKeyA = (await seedApiKey(prisma, tenantA.id)).plainKey;
    apiKeyB = (await seedApiKey(prisma, tenantB.id)).plainKey;

    adminTokenA = await login(adminA.email, adminA.password);
    miembroTokenA = await login(miembroA.email, miembroA.password);
    superadminToken = await login(superadmin.email, superadmin.password);

    await seedAccount(tenantA, accountA1, 'compras_a1');
    await seedAccount(tenantA, accountA2, 'compras_a2');
    await seedAccount(tenantB, accountB1, 'compras_b1');

    // Tenant A: los dos DTE de muestra.
    const attV3 = await seedDteAttachment({
      tenant: tenantA,
      accountId: accountA1,
      folderName: 'compras_a1',
      dte: ccfV3,
      fileName: 'ccf-v3.json',
    });
    const attV4 = await seedDteAttachment({
      tenant: tenantA,
      accountId: accountA1,
      folderName: 'compras_a1',
      dte: ccfV4,
      fileName: 'ccf-v4.json',
    });

    // Tenant B: el MISMO DTE v4. Debe generar su propio documento, no un duplicado.
    const attB = await seedDteAttachment({
      tenant: tenantB,
      accountId: accountB1,
      folderName: 'compras_b1',
      dte: ccfV4,
      fileName: 'ccf-v4.json',
    });

    await ingest.ingestAttachment(tenantA.id, attV3);
    await ingest.ingestAttachment(tenantA.id, attV4);
    await ingest.ingestAttachment(tenantB.id, attB);

    const docs = await prisma.purchaseDocument.findMany({
      where: { tenantId: tenantA.id },
      select: { id: true, version: true, receptorId: true },
    });
    const v3 = docs.find((d) => d.version === 3)!;
    docV3Id = v3.id;
    receptorV3Id = v3.receptorId;
    const v4 = docs.find((d) => d.version === 4)!;
    docV4Id = v4.id;
    receptorV4Id = v4.receptorId;
  }

  const get = (path: string, key = apiKeyA) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set('X-Api-Key', key);

  const patchAsAdmin = (path: string) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminTokenA}`);

  // -------------------------------------------------------------------------

  describe('ingesta', () => {
    it('incorpora los dos DTE del tenant A con sus ítems y tributos', async () => {
      const res = await get('/purchase-book/documents');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(2);
      expect(res.body.data.map((d: { tipoDte: string }) => d.tipoDte)).toEqual(['03', '03']);
    });

    it('normaliza los alias de v3 en la base', async () => {
      const doc = await prisma.purchaseDocument.findUnique({ where: { id: docV3Id } });
      expect(doc?.ivaRetenido.toString()).toBe('1.77');
      expect(doc?.ivaCreditoFiscal.toString()).toBe('23.01');
    });

    it('crea el ledger de parseo con estado PARSEADO', async () => {
      const results = await prisma.dteParseResult.findMany({
        where: { tenantId: tenantA.id },
      });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'PARSEADO')).toBe(true);
    });

    it('el mismo DTE en dos tenants genera un documento por tenant', async () => {
      // La base de test no se trunca entre corridas: se acota a los tenants
      // sembrados por ESTA corrida.
      const docs = await prisma.purchaseDocument.findMany({
        where: {
          codigoGeneracion: '0B4E2221-74CF-4550-A451-31BBFB5CC9FD',
          tenantId: { in: [tenantA.id, tenantB.id] },
        },
        select: { tenantId: true },
      });

      expect(docs).toHaveLength(2);
      expect(new Set(docs.map((d) => d.tenantId))).toEqual(new Set([tenantA.id, tenantB.id]));
    });

    it('el mismo DTE en otro buzón del mismo tenant queda como DUPLICADO', async () => {
      const attDup = await seedDteAttachment({
        tenant: tenantA,
        accountId: accountA2,
        folderName: 'compras_a2',
        dte: ccfV4,
        fileName: 'ccf-v4-dup.json',
      });

      const status = await ingest.ingestAttachment(tenantA.id, attDup);

      expect(status).toBe('DUPLICADO');
      const ledger = await prisma.dteParseResult.findUnique({
        where: { attachmentId: attDup },
      });
      expect(ledger?.documentId).toBe(docV4Id);

      // El total del listado no cambia: sigue habiendo 2 documentos.
      const res = await get('/purchase-book/documents');
      expect(res.body.meta.total).toBe(2);
    });
  });

  describe('aislamiento entre tenants', () => {
    it('el tenant B no ve los documentos del tenant A', async () => {
      const res = await get('/purchase-book/documents', apiKeyB);
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: { id: string }) => d.id)).not.toContain(docV3Id);
    });

    it('pedir el detalle de un documento ajeno devuelve 404, no 403', async () => {
      const res = await get(`/purchase-book/documents/${docV3Id}`, apiKeyB);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PURCHASE_DOCUMENT_NOT_FOUND');
    });

    it('SUPERADMIN no consulta el libro de un tenant', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/purchase-book/documents')
        .set('Authorization', `Bearer ${superadminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_ROLE');
    });

    it('sin credenciales devuelve 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/purchase-book/documents');
      expect(res.status).toBe(401);
    });
  });

  describe('filtros', () => {
    it('filtra por receptor', async () => {
      const res = await get(`/purchase-book/documents?receptorId=${receptorV4Id}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(docV4Id);
    });

    it('filtra por período con month', async () => {
      const res = await get('/purchase-book/documents?month=2026-05');
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(docV4Id);
    });

    it('filtra por rango de fecha de emisión', async () => {
      const res = await get('/purchase-book/documents?from=2026-03-01&to=2026-03-31');
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(docV3Id);
    });

    it('busca por número de control', async () => {
      const res = await get('/purchase-book/documents?q=000000000000125');
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(docV4Id);
    });

    it('rechaza un formato de fecha inválido', async () => {
      const res = await get('/purchase-book/documents?from=marzo');
      expect(res.status).toBe(400);
    });

    it('rechaza un parámetro desconocido (whitelist del ValidationPipe)', async () => {
      const res = await get('/purchase-book/documents?ordenar=descendente');
      expect(res.status).toBe(400);
    });
  });

  describe('resumen', () => {
    it('suma los totales del filtro y los devuelve como string', async () => {
      const res = await get('/purchase-book/documents/summary');

      expect(res.status).toBe(200);
      expect(res.body.data.documentCount).toBe(2);
      expect(res.body.data.totalGravada).toBe('320.99');
      expect(typeof res.body.data.ivaCreditoFiscal).toBe('string');
    });

    it('respeta el filtro de período', async () => {
      const res = await get('/purchase-book/documents/summary?month=2026-05');
      expect(res.body.data.documentCount).toBe(1);
      expect(res.body.data.totalGravada).toBe('144');
    });
  });

  describe('detalle', () => {
    it('incluye ítems, tributos y pagos', async () => {
      const res = await get(`/purchase-book/documents/${docV4Id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.taxes).toHaveLength(1);
      expect(res.body.data.payments).toHaveLength(1);
    });

    it('oculta rawJson a un actor MIEMBRO (la API key lo es)', async () => {
      const res = await get(`/purchase-book/documents/${docV4Id}`);
      expect(res.body.data.rawJson).toBeNull();
    });

    it('incluye rawJson para ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/purchase-book/documents/${docV4Id}`)
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res.body.data.rawJson).not.toBeNull();
      expect(res.body.data.rawJson.identificacion.tipoDte).toBe('03');
    });

    it('no devuelve rutas absolutas del servidor', async () => {
      const res = await get(`/purchase-book/documents/${docV4Id}`);
      expect(JSON.stringify(res.body)).not.toContain(process.env.STORAGE_ROOT);
    });
  });

  describe('clasificación', () => {
    it('un MIEMBRO no puede clasificar', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/purchase-book/documents/${docV4Id}/classification`)
        .set('Authorization', `Bearer ${miembroTokenA}`)
        .send({ anexoSector: 2 });

      expect(res.status).toBe(403);
    });

    it('un ADMIN clasifica y queda registrado quién lo hizo', async () => {
      const res = await patchAsAdmin(`/purchase-book/documents/${docV4Id}/classification`).send({
        anexoTipoOperacion: 1,
        anexoClasificacion: 2,
        anexoSector: 4,
        anexoTipoCostoGasto: 2,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.anexoSector).toBe(4);
      expect(res.body.data.classifiedById).toBeTruthy();
    });

    it('rechaza un código fuera del catálogo', async () => {
      const res = await patchAsAdmin(`/purchase-book/documents/${docV4Id}/classification`).send({
        anexoClasificacion: 5,
      });

      expect(res.status).toBe(400);
    });

    it('un null explícito limpia el override', async () => {
      await patchAsAdmin(`/purchase-book/documents/${docV4Id}/classification`).send({
        anexoSector: null,
      });
      const doc = await prisma.purchaseDocument.findUnique({ where: { id: docV4Id } });
      expect(doc?.anexoSector).toBeNull();

      // se restaura para los tests siguientes
      await patchAsAdmin(`/purchase-book/documents/${docV4Id}/classification`).send({
        anexoSector: 4,
      });
    });

    it('no permite clasificar un documento de otro tenant', async () => {
      const res = await patchAsAdmin(
        `/purchase-book/documents/${randomUUID()}/classification`,
      ).send({ anexoSector: 2 });

      expect(res.status).toBe(404);
    });
  });

  describe('catálogo de partes', () => {
    it('lista los emisores del tenant', async () => {
      const res = await get('/purchase-book/parties?role=EMISOR');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data.every((p: { seenAsEmisor: boolean }) => p.seenAsEmisor)).toBe(true);
    });

    it('lista los receptores del tenant', async () => {
      const res = await get('/purchase-book/parties?role=RECEPTOR');
      expect(res.body.data.every((p: { seenAsReceptor: boolean }) => p.seenAsReceptor)).toBe(true);
    });

    it('exige el rol', async () => {
      const res = await get('/purchase-book/parties');
      expect(res.status).toBe(400);
    });

    it('un ADMIN configura los defaults del receptor', async () => {
      const res = await patchAsAdmin(`/purchase-book/parties/${receptorV4Id}/defaults`).send({
        defaultTipoOperacion: 1,
        defaultClasificacion: 2,
        defaultSector: 4,
        defaultTipoCostoGasto: 2,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.defaultClasificacion).toBe(2);
    });

    it('un MIEMBRO no configura defaults', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/purchase-book/parties/${receptorV4Id}/defaults`)
        .set('Authorization', `Bearer ${miembroTokenA}`)
        .send({ defaultSector: 1 });

      expect(res.status).toBe(403);
    });
  });

  describe('catálogos de Hacienda', () => {
    it('expone las cuatro columnas del anexo con sus etiquetas', async () => {
      const res = await get('/purchase-book/catalogs');

      expect(res.status).toBe(200);
      expect(res.body.data.clasificacion).toContainEqual({ code: 1, label: 'Costo' });
      expect(res.body.data.tipoOperacion.map((o: { code: number }) => o.code)).toContain(8);
    });
  });

  describe('reprocesamiento', () => {
    it('un MIEMBRO no puede reprocesar', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/purchase-book/reprocess')
        .set('Authorization', `Bearer ${miembroTokenA}`)
        .send({ mode: 'missing' });

      expect(res.status).toBe(403);
    });

    it('modo missing no encola nada cuando todo está parseado', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/purchase-book/reprocess')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ mode: 'missing' });

      expect(res.status).toBe(201);
      expect(res.body.data.enqueued).toBe(0);
      expect(res.body.data.nextCursor).toBeNull();
    });

    /**
     * Regresión: hasta acá ninguna prueba encolaba de verdad. `enqueueParseBulk`
     * captura los errores de BullMQ y devuelve 0 (encolar no puede hacer fallar
     * el archivado del correo), así que un `jobId` inválido dejaba la cola vacía
     * sin que ningún test ni ningún log lo notara. Este caso sí exige que el
     * adjunto llegue a la cola.
     *
     * Va después del caso "no encola nada": deja un adjunto sin parsear.
     */
    it('modo missing encola el adjunto que todavía no pasó por el parser', async () => {
      await seedDteAttachment({
        tenant: tenantA,
        accountId: accountA1,
        folderName: 'compras_a1',
        dte: ccfV4,
        fileName: 'sin-parsear.json',
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/purchase-book/reprocess')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ mode: 'missing' });

      expect(res.status).toBe(201);
      expect(res.body.data.enqueued).toBe(1);
    });

    it('rechaza un modo desconocido', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/purchase-book/reprocess')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ mode: 'todos' });

      expect(res.status).toBe(400);
    });
  });

  describe('ledger de parseo', () => {
    it('un ADMIN consulta los resultados de parseo', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/purchase-book/parse-results')
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
    });

    it('un MIEMBRO no accede al ledger', async () => {
      const res = await get('/purchase-book/parse-results');
      expect(res.status).toBe(403);
    });
  });
  /**
   * El endpoint de export está limitado a 10 llamadas por minuto
   * (`@Throttle` en `PurchaseBookController.export`; tabla de la API en el
   * Addendum 10, §7). Estos tests consolidan varias aserciones por respuesta a
   * propósito: pedir el mismo archivo una vez por aserción agotaría el límite y
   * los tests empezarían a recibir 429 en vez de probar lo que dicen probar.
   *
   * PRESUPUESTO: este describe usa exactamente 10 peticiones a `/export`, o sea
   * el límite completo. Antes de agregar una, hay que sacar otra o subir el
   * `@Throttle`; si no, aparecen 429 intermitentes que parecen fallos ajenos.
   *
   * Toda petición de export afirma su `status` ANTES de leer el cuerpo. Un 422
   * devuelve JSON, y parsearlo como CSV produce aserciones que pasan sin probar
   * nada: ya ocurrió una vez en esta suite.
   */
  describe('exportación del Anexo 3', () => {
    /** Lee la respuesta como Buffer, para poder inspeccionar los bytes crudos. */
    const asBuffer = (path: string, key = apiKeyA) =>
      get(path, key)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

    const lines = (body: Buffer): string[] =>
      body
        .toString('utf8')
        .split('\r\n')
        .filter((line) => line.length > 0);

    /**
     * La columna D lleva el código de generación sin guiones. Se le devuelven
     * para poder buscar el documento en la base y verificar a qué receptor
     * pertenece cada fila realmente emitida.
     */
    const restoreCodigoGeneracion = (cell: string): string =>
      [
        cell.slice(0, 8),
        cell.slice(8, 12),
        cell.slice(12, 16),
        cell.slice(16, 20),
        cell.slice(20),
      ].join('-');

    /** Segundo documento del MISMO receptor que v4, en un mes anterior. */
    let docAbrilId: string;

    beforeAll(async () => {
      // Un segundo documento del receptor de v4 permite probar el orden y la
      // homogeneidad del archivo sin mezclar contribuyentes.
      const abril = JSON.parse(JSON.stringify(ccfV4)) as typeof ccfV4;
      abril.identificacion.codigoGeneracion = 'A1B2C3D4-1111-4222-8333-444455556666';
      abril.identificacion.numeroControl = 'DTE-03-M001P001-000000000000099';
      abril.identificacion.fecEmi = '2026-04-09';

      const attAbril = await seedDteAttachment({
        tenant: tenantA,
        accountId: accountA1,
        folderName: 'compras_a1',
        dte: abril,
        fileName: 'ccf-v4-abril.json',
      });
      await ingest.ingestAttachment(tenantA.id, attAbril);
      docAbrilId = (
        await prisma.purchaseDocument.findFirstOrThrow({
          where: { tenantId: tenantA.id, codigoGeneracion: abril.identificacion.codigoGeneracion },
          select: { id: true },
        })
      ).id;

      // Todos clasificados: si no, el export se bloquea con 422.
      for (const id of [docV3Id, docV4Id, docAbrilId]) {
        await patchAsAdmin(`/purchase-book/documents/${id}/classification`).send({
          anexoTipoOperacion: 1,
          anexoClasificacion: 2,
          anexoSector: 4,
          anexoTipoCostoGasto: 2,
        });
      }
    });

    describe('CSV', () => {
      let res: request.Response;
      let body: Buffer;

      beforeAll(async () => {
        res = await asBuffer(
          `/purchase-book/export?format=csv&month=2026-05&receptorId=${receptorV4Id}`,
        );
        body = res.body as Buffer;
      });

      it('responde con el content-type y el nombre de archivo con el NIT del receptor', () => {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="compras_${RECEPTOR_V4_NIT}_2026-05.csv"`,
        );
      });

      it('no lleva BOM: el primer byte es el de la fecha', () => {
        expect(body[0]).not.toBe(0xef);
        expect(body.subarray(0, 10).toString('utf8')).toBe('28/05/2026');
      });

      it('usa CRLF, 21 columnas separadas por punto y coma, y no trae encabezado', () => {
        const text = body.toString('utf8');
        expect(text.endsWith('\r\n')).toBe(true);

        const rows = lines(body);
        expect(rows).toHaveLength(1);
        expect(rows[0].split(';')).toHaveLength(21);
        // Sin encabezado: la primera celda ya es un dato, no un rótulo.
        expect(rows[0].split(';')[0]).toBe('28/05/2026');
      });

      it('la columna O es el neto, sin sumar el crédito fiscal de N', () => {
        const fields = lines(body)[0].split(';');
        expect(fields[9]).toBe('144.00'); // J compras internas gravadas
        expect(fields[13]).toBe('18.72'); // N crédito fiscal
        expect(fields[14]).toBe('144.00'); // O total de compras
      });

      it('aplica la regla E/P según la longitud del identificador', async () => {
        const marzo = await asBuffer(
          `/purchase-book/export?format=csv&from=2026-03-01&to=2026-03-31&receptorId=${receptorV3Id}`,
        );
        // Antes de tocar el cuerpo: un 422 es JSON y parsearlo como CSV daría
        // aserciones que pasan sin probar nada.
        expect(marzo.status).toBe(200);
        const fields = lines(marzo.body as Buffer)[0].split(';');

        // El emisor de la muestra v3 tiene 9 dígitos: va en P, no en E.
        expect(fields[4]).toBe('');
        expect(fields[15]).toBe('040522092');

        // Otro receptor, otro nombre de archivo: dos clientes del mismo
        // operador no pueden terminar con archivos indistinguibles.
        expect(marzo.headers['content-disposition']).toBe(
          `attachment; filename="compras_${RECEPTOR_V3_NIT}_2026-03-01.csv"`,
        );
      });

      /**
       * Validez fiscal del archivo, no formato de las columnas: el Anexo 3 se
       * presenta por contribuyente, así que TODAS las filas emitidas tienen que
       * pertenecer al mismo receptor. El receptor no viaja en ninguna de las 21
       * columnas, así que se reconstruye mapeando la columna D (código de
       * generación sin guiones) contra la base.
       */
      it('exporta un único contribuyente, ordenado por fecha de emisión ascendente', async () => {
        const todos = await asBuffer(`/purchase-book/export?format=csv&receptorId=${receptorV4Id}`);
        const rows = lines(todos.body as Buffer);

        expect(todos.status).toBe(200);
        expect(rows).toHaveLength(2);
        expect(rows[0].split(';')[0]).toBe('09/04/2026');
        expect(rows[1].split(';')[0]).toBe('28/05/2026');

        const exportados = await prisma.purchaseDocument.findMany({
          where: {
            tenantId: tenantA.id,
            codigoGeneracion: { in: rows.map((row) => restoreCodigoGeneracion(row.split(';')[3])) },
          },
          select: { receptorId: true, receptorNit: true },
        });

        expect(exportados).toHaveLength(rows.length);
        expect(new Set(exportados.map((doc) => doc.receptorId)).size).toBe(1);
        expect(new Set(exportados.map((doc) => doc.receptorNit))).toEqual(
          new Set([RECEPTOR_V4_NIT]),
        );
      });

      it('un tenant no exporta las compras de otro', async () => {
        // El receptor es del tenant A: para el tenant B el filtro no existe.
        const otro = await get(
          `/purchase-book/export?format=csv&receptorId=${receptorV4Id}`,
          apiKeyB,
        );

        expect(otro.status).toBe(422);
        expect(otro.body.error).toBe('PURCHASE_BOOK_EMPTY');
      });
    });

    it('el XLSX es un libro OOXML válido', async () => {
      const res = await asBuffer(
        `/purchase-book/export?format=xlsx&month=2026-05&receptorId=${receptorV4Id}`,
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="compras_${RECEPTOR_V4_NIT}_2026-05.xlsx"`,
      );
      expect((res.body as Buffer).subarray(0, 2).toString('ascii')).toBe('PK');
    });

    describe('validaciones previas al streaming', () => {
      /**
       * Las dos validaciones del DTO comparten una sola petición a propósito:
       * el `ValidationPipe` acumula todos los errores en la misma respuesta y el
       * endpoint tiene 10 llamadas por minuto. Se afirman ambos mensajes, así
       * que ninguna de las dos reglas puede romperse sin que el test falle.
       */
      it('rechaza un export sin receptorId y con formato desconocido', async () => {
        const res = await get('/purchase-book/export?format=pdf&month=2026-05');

        expect(res.status).toBe(400);
        // Sin receptor no hay Anexo 3 posible: se presenta por contribuyente.
        expect(res.body.message).toContain('receptorId debe ser un UUID válido');
        expect(res.body.message).toContain('format debe ser csv o xlsx');
      });

      it('rechaza con 422 un filtro sin compras', async () => {
        const res = await get(
          `/purchase-book/export?format=csv&month=2019-01&receptorId=${receptorV4Id}`,
        );
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('PURCHASE_BOOK_EMPTY');
      });

      it('SUPERADMIN no puede exportar', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/purchase-book/export?format=csv&receptorId=${receptorV4Id}`)
          .set('Authorization', `Bearer ${superadminToken}`);

        expect(res.status).toBe(403);
      });
    });

    it('bloquea el export con compras sin clasificar y lo permite con allowUnclassified', async () => {
      // Se limpian override y default para dejar el documento sin clasificar.
      await patchAsAdmin(`/purchase-book/documents/${docV4Id}/classification`).send({
        anexoTipoOperacion: null,
        anexoClasificacion: null,
        anexoSector: null,
        anexoTipoCostoGasto: null,
      });
      await patchAsAdmin(`/purchase-book/parties/${receptorV4Id}/defaults`).send({
        defaultTipoOperacion: null,
        defaultClasificacion: null,
        defaultSector: null,
        defaultTipoCostoGasto: null,
      });

      const bloqueado = await get(
        `/purchase-book/export?format=csv&month=2026-05&receptorId=${receptorV4Id}`,
      );
      expect(bloqueado.status).toBe(422);
      expect(bloqueado.body.error).toBe('PURCHASE_BOOK_UNCLASSIFIED');

      const permitido = await asBuffer(
        `/purchase-book/export?format=csv&month=2026-05&receptorId=${receptorV4Id}&allowUnclassified=true`,
      );
      expect(permitido.status).toBe(200);
      const fields = lines(permitido.body as Buffer)[0].split(';');
      expect(fields.slice(16, 20)).toEqual(['', '', '', '']);
    });
  });
});
