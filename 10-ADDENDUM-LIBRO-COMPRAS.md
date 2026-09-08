# Addendum 10 — Libro de Compras (parseo de DTE y Anexo 3 "Detalle de Compras")

Estado: **plan aprobado, pendiente de implementación**
Depende de: `03-ARQUITECTURA-TECNICA.md`, `07-ADDENDUM-EXPORT-SYNC.md`, `08-ADDENDUM-MULTITENANT.md`
Fecha de decisión: 2026-09-07

Este documento es la **meta de implementación**. Cada fase de la sección 12 se ejecuta en
orden, cierra con sus gates y se marca como implementada aquí mismo antes de pasar a la
siguiente. Ante cualquier duda manda `CLAUDE.md`, luego este addendum, luego la arquitectura.

---

## 1. Problema

MailDTE descarga y archiva los JSON/PDF de DTE que llegan a los buzones IMAP, pero el
contenido de esos JSON es opaco para el sistema. El contador sigue abriendo archivo por
archivo para armar el Libro de Compras y el Anexo 3 "Detalle de Compras" que exige el
Ministerio de Hacienda para la declaración de IVA (F-07). El PRD ya reservaba el "parseo del
contenido del JSON DTE" como Fase 2; este addendum la especifica.

Tres complicaciones reales que el diseño tiene que absorber:

1. Los emisores mandan DTE en **versión 3 y versión 4** del esquema de Hacienda, con nombres
   de campo distintos en `resumen` y en `emisor`.
2. **Un mismo buzón recibe DTE a favor de más de un receptor** (un despacho contable
   administra varios clientes con un solo correo). El receptor es una dimensión de filtro de
   primera clase, no un dato incidental.
3. Cuatro columnas del anexo (tipo de operación, clasificación, sector y tipo de costo/gasto)
   **no existen en el DTE**: son criterio contable del contribuyente.

## 2. Objetivo

1. Parsear todo adjunto JSON con `identificacion.tipoDte = "03"` (Comprobante de Crédito
   Fiscal) en tablas normalizadas: identificación, emisor, receptor, resumen y
   `cuerpoDocumento`, con compatibilidad v3/v4 y conservando el JSON crudo.
2. Vistas responsivas en el panel con filtros por **emisor**, **receptor**, **período**,
   cuenta y estado de clasificación, con totales del filtro activo.
3. Clasificación Q–T con **valores por defecto por receptor y edición por documento**.
4. Exportación del filtro activo al **Anexo 3** en **CSV delimitado por `;`** y **XLSX**.
5. Todo lo anterior bajo el aislamiento multi-tenant existente (RLS), con compilación,
   lint, tests y auditoría de dependencias como condición de terminado de cada fase.

Fuera de alcance de este addendum (habilitado por el esquema, no implementado): notas de
crédito/débito (`05`/`06`) en el libro, documentos anteriores a noviembre 2022, override
manual de identificación del proveedor.

---

## 3. Hallazgos que condicionan el diseño

### 3.1 Formato del Anexo 3 "Detalle de Compras"

Fuente: instructivo del Ministerio de Hacienda, sección V (págs. 12–15). Archivo **sin
encabezados ni celdas combinadas**, 21 columnas en este orden:

| Col | Dato | Long. | Origen en el DTE (CCF) |
|---|---|---|---|
| A | Fecha de emisión `DD/MM/AAAA` | 10 | `identificacion.fecEmi` |
| B | Clase de documento | 1 | constante `4` (Documento Tributario Electrónico) |
| C | Tipo de documento | 2 | `identificacion.tipoDte` (`03`) |
| D | Número de documento | 100 | `identificacion.codigoGeneracion` **sin guiones** |
| E | NIT o NRC del proveedor | 14 | `emisor.nit` si tiene 14 dígitos; **vacío si P lleva valor** |
| F | Nombre del proveedor | libre | `emisor.nombre` |
| G | Compras internas exentas y/o no sujetas | 10 | `resumen.totalExenta + resumen.totalNoSuj` |
| H | Internaciones exentas y/o no sujetas | 10 | `0.00` (solo Declaración de Mercancías) |
| I | Importaciones exentas y/o no sujetas | 10 | `0.00` |
| J | Compras internas gravadas | 10 | `resumen.totalGravada` |
| K | Internaciones gravadas de bienes | 10 | `0.00` |
| L | Importaciones gravadas de bienes | 10 | `0.00` |
| M | Importaciones gravadas de servicios | 10 | `0.00` |
| N | Crédito fiscal | 10 | `resumen.tributos[codigo = "20"].valor` |
| O | Total de compras | 10 | **suma de G a M** (neto gravado; N NO se incluye) |
| P | DUI del proveedor | 9 | `emisor.nit` si tiene **9 dígitos** (NIT homologado a DUI, persona natural); E vacío |
| Q | Tipo de operación | 1 | 1 Gravada, 2 No gravada, 3 Excluido/no constituye renta, 4 Mixta |
| R | Clasificación | 1 | 1 Costo, 2 Gasto |
| S | Sector | 1 | 1 Industria, 2 Comercio, 3 Agropecuaria, 4 Servicios/profesiones/artes/oficios |
| T | Tipo de costo/gasto | 1 | 1 Gastos de venta, 2 Gastos de administración, 3 Gastos financieros, 4 Costo artículos importados/internados, 5 Costo artículos internos, 6 Costos indirectos de fabricación, 7 Mano de obra |
| U | Número de anexo | 1 | constante `3` |

Reglas del instructivo que se implementan tal cual:

- Q–T aplican a partir del período **febrero 2024**; períodos anteriores llevan `0` en las
  cuatro columnas.
- Código `8` = operación informada en más de un anexo; código `9` = no deducible
  (instituciones públicas, municipalidades). Ambos son válidos en las cuatro columnas Q–T.
- Montos: máximo 2 decimales, punto decimal, sin separador de miles, **nunca negativos**,
  `0.00` cuando no aplica. Hacienda **trunca** a 2 decimales si recibe más; por eso se emite
  siempre exactamente 2 (redondeo HALF_UP) y la truncación resulta inocua.
- E y P son mutuamente excluyentes. Ambos sin guiones ni pleca.

### 3.2 Diferencias entre versión 3 y versión 4 (muestras reales)

| Sección | v3 | v4 | Normalización |
|---|---|---|---|
| `resumen` | `ivaRete1`, `ivaPerci1`, `reteRenta` | `ivaRete`, `ivaPerci`, `observaciones` | columnas únicas `ivaRetenido`, `ivaPercibido`, `retencionRenta`, `observaciones` |
| `emisor` | `tipoEstablecimiento`, `codEstableMH`, `codPuntoVentaMH` presentes | ausentes | columnas nullable |
| `direccion` | sin `distrito` | con `distrito` | nullable |
| `extension` | presente | ausente | `Json?`; `extension.observaciones` alimenta `observaciones` si `resumen` no lo trae |
| `cuerpoDocumento[].tributos` | `string[] \| null` | igual | `String[]`, `null → []` |
| `resumen.tributos` | `{codigo, descripcion, valor}[]` | igual | tabla hija |
| `emisor.nit` | 9 dígitos (`040522092`) | 9 dígitos (`027561310`) | regla E/P por longitud |
| `receptor.nit` | 14 dígitos | 14 dígitos | — |
| `precioUni` | hasta 8 decimales (`176.99115044`) | igual | `Decimal(18, 8)` |

Los campos de retención/percepción **faltan con frecuencia**; su ausencia no es error, vale
`0`. Algunos emisores envían montos como string numérico (`"176.99"`): se acepta.

### 3.3 Auditoría de librerías (verificada contra el registry y bases de advisories el 2026-09-07)

| Librería | Veredicto | Motivo |
|---|---|---|
| `xlsx` (SheetJS, npm 0.18.5) | **Prohibida** | CVE-2023-30533 (prototype pollution) y CVE-2024-22363 (ReDoS) sin parche en npm; el paquete está abandonado en el registry (los fixes viven solo en el CDN del autor). |
| `exceljs` 4.4.0 | **Prohibida** | Última publicación 2024-12-20. CVE-2026-78207 (prototype pollution en `deepMerge`, CVSS 9.4, afecta hasta 4.4.0, corregida únicamente en el fork `exceljs-hardened`), CVE-2026-78208 (path traversal en `addImage`), dependencias transitivas vulnerables `glob@7` (CVE-2025-64756), `tmp@0.2.0`, `uuid@8`, `unzipper@0.10`. |
| `write-excel-file` 4.1.1 | **Adoptada** (Fase 0, ver §12) | MIT, única dependencia `fflate@^0.8.2` (MIT), publicada 2026-06, sin advisories. Auditada y confirmada en la Fase 0. |
| Escritor OOXML propio sobre `archiver` (ya en `dependencies`) | **Fallback** | Cero dependencias nuevas, ~150 líneas: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` (un `numFmt` `0.00`), `xl/worksheets/sheet1.xml` con celdas `inlineStr` y `n`. Se prueba descomprimiendo con `adm-zip` (ya devDependency). |
| `zod` / validadores de esquema | **No se agrega** | La forma consumida es pequeña (~70 escalares), debe ser tolerante a campos extra y a alias; el narrowing manual produce errores en español con ruta y no suma dependencias (regla 3 de `CLAUDE.md`). |
| Librería CSV | **No se agrega** | Generación propia por streaming; el formato es trivial y las reglas de Hacienda son específicas. |
| Librería de decimales | **No se agrega** | `Prisma.Decimal` (decimal.js) ya se exporta desde `@prisma/client` (verificado en `node_modules/.prisma/client/index.d.ts`). |

### 3.4 Piezas existentes que se reutilizan

- RLS: `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy
  `tenant_isolation USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''))`
  + `GRANT ... TO "maildte_app"`, escritos a mano en la migración
  (`prisma/migrations/20260809050000_multi_tenancy/migration.sql`,
  `20260901120000_mail_providers/migration.sql`, `20260902000000_fix_superadmin_rls_null_tenant`).
- `PrismaService.withTenant(tenantId, fn)` (`src/prisma/prisma.service.ts`); `tenantId`
  repetido en cada `where`; acceso cross-tenant → 404; `requireTenantId` → `FORBIDDEN_ROLE`
  para SUPERADMIN (`src/emails/emails.service.ts`).
- Punto de enganche: `SyncService.processMessage` (`src/sync/sync.service.ts`), que crea
  `processedEmail` con `attachments.create` anidado dentro de `withTenant`.
- BullMQ crudo: `src/sync/queue/*.ts` (Queue inyectada por `Symbol`,
  `bullmqConnectionOptions`), `src/sync/sync.processor.ts` (`new Worker` manual), registrado
  solo en `src/worker.module.ts`.
- `StorageService.resolveSafe(tenantSlug, relativePath)` (`src/storage/storage.service.ts`).
- Export en streaming: `src/export/export.controller.ts` + `export.service.ts`
  (`@Throttle`, conteo previo → `422 EXPORT_TOO_LARGE`, `res.destroy` tras headers,
  `buildExportWhere` puro y testeable). Fechas: `src/common/utils/date-range.ts`.
- DTO de listado modelo: `src/emails/dto/list-emails.dto.ts`. Config: `src/config/env.validation.ts`
  + `src/config/app-config.service.ts`.
- Tests: `*.spec.ts` junto al código con `prismaMock.withTenant = jest.fn((_, fn) => fn(prismaMock))`
  (`src/accounts/accounts.service.spec.ts`); e2e en `test/` con
  `test/helpers/tenant-fixtures.ts` sobre `maildte_test` con RLS real.
- Frontend `web/`: `FiltersPanel`, `Pagination`, `RecordCard` (`web/src/components/common/`),
  primitivas `web/src/components/ui/*`, `useAccounts`, `api-client.ts` (`apiGet/apiPost/apiPatch/apiDownload`),
  tipos en `web/src/types/domain.ts`, nav `NAV_ITEMS` en `web/src/components/layout/AppLayout.tsx`,
  rutas en `web/src/App.tsx`. Página modelo: `web/src/pages/CorreosPage.tsx` +
  `web/src/components/emails/ExportZipPanel.tsx`.

---

## 4. Decisiones de arquitectura

### ADR-10.1 — Ledger de parseo separado del documento

`dte_parse_results` registra **exactamente una fila por adjunto JSON** procesado (único por
`attachmentId`) con estado, error y versión del parser. `purchase_documents` contiene **solo**
CCF parseados correctamente.

Consecuencias:

- Listado, totales y export nunca tienen que excluir filas de error.
- Los tipos distintos de `03` se registran como `IGNORADO_TIPO` conservando `tipoDte`:
  habilitar `05`/`06` después no exige cambio de esquema.
- El mismo DTE recibido en dos buzones del mismo tenant produce un documento canónico y una
  fila `DUPLICADO` que apunta a él. El mismo DTE en dos tenants distintos produce dos
  documentos: cada tenant es dueño de su copia.
- `parserVersion` en ledger y documento permite re-parsear selectivamente cuando cambia la
  normalización.

Alternativa descartada: `parseStatus` como columna del documento. Obliga a filtrar en cada
consulta y no modela el duplicado.

### ADR-10.2 — Catálogo de partes + snapshot en el documento

`dte_parties` (único por `[tenantId, nit]`) es el catálogo vivo de emisores y receptores:
alimenta los selects de filtro y guarda los **defaults Q–T del receptor**. El documento
guarda además snapshot de `nit`, `nrc` y `nombre` de emisor y receptor: la columna F del
anexo debe ser reproducible aunque el proveedor cambie de razón social en el catálogo.

### ADR-10.3 — Dinero como `Decimal @db.Decimal(18, 8)`

`precioUni` llega con 8 decimales; la ingesta se guarda sin pérdida y el redondeo ocurre en
un único punto: la exportación (`ROUND_HALF_UP` a 2 decimales). Precisión uniforme en todas
las columnas monetarias para no discutir caso por caso; el costo de `numeric` en Postgres es
irrelevante. **Prohibido** `Number()` / `parseFloat()` sobre montos en todo `src/purchase-book`.

### ADR-10.4 — Catálogos de Hacienda como const maps en TypeScript

Tipo de operación, clasificación, sector, tipo de costo/gasto, tipo de DTE, condición de
operación y formas de pago son listas cerradas definidas por Hacienda con etiqueta en
español. Viven en `src/purchase-book/anexo/classification-catalogs.ts`, se validan con
`@IsIn` y se exponen en `GET /purchase-book/catalogs` para que el panel tenga una sola fuente.

Valores admitidos por columna: Q `{1,2,3,4,8,9}`, R `{1,2,8,9}`, S `{1,2,3,4,8,9}`,
T `{1,2,3,4,5,6,7,8,9}`.

### ADR-10.5 — Precedencia de clasificación

`override del documento` → `default del receptor` → `null`. Se resuelve en una función pura
`resolveClassification(doc, receptor)` que además devuelve el origen
(`override | default | pre-2024-02 | missing`). Períodos anteriores a 2024-02 exportan `0`.

El export **rechaza con 422 `PURCHASE_BOOK_UNCLASSIFIED`** cuando hay filas sin clasificar,
salvo `allowUnclassified=true`; en ese caso la celda va vacía. **Nunca** se inventa un código.

### ADR-10.6 — XLSX con `write-excel-file`, fallback OOXML propio

Se adopta `write-excel-file` con versión fijada (`pnpm add -E`) **si y solo si** la auditoría
de la Fase 0 queda limpia. Si no, se implementa el escritor OOXML mínimo sobre `archiver`.
`exceljs` y `xlsx` quedan prohibidos por las CVE de §3.3; la prohibición se registra en el
cuerpo del commit que agregue la dependencia (regla 3 de `CLAUDE.md`).

### ADR-10.7 — Validación del JSON con narrowing manual

Helpers puros en `src/purchase-book/parser/json-access.ts`: `isPlainObject`,
`getRequiredString`, `getOptionalString`, `getRequiredNumber`, `getOptionalNumber`,
`getRequiredInt`, `getRequiredArray`, `getObject`, `toDecimal`. Acumulan `DteFieldError[]`
(`{ path, message }`, mensajes en español) en lugar de lanzar, para reportar todos los
problemas de un archivo en una pasada. Acceso con `Object.prototype.hasOwnProperty.call`;
**nunca** se hace merge ni spread del JSON crudo sobre otro objeto: una clave `__proto__` en
el archivo es inerte.

### ADR-10.8 — `fecEmi` como `DateTime @db.Date`; `rawJson` como `jsonb`

`fecEmi` es una fecha calendario emitida por Hacienda sin zona; `DATE` no tiene zona y por
tanto respeta la regla 7 (UTC en BD). `horEmi` se guarda como texto. `rawJson` conserva el DTE
íntegro para el detalle y para re-normalizaciones futuras; las secciones sin normalizar
(`documentoRelacionado`, `otrosDocumentos`, `ventaTercero`, `extension`, `apendice`) se copian
además a columnas `Json?` propias para consulta barata.

### ADR-10.9 — Columna O es la suma de G a M; el crédito fiscal de N queda fuera

Decidido el 2026-09-07, cierra el riesgo 1 que quedó abierto en el diseño.

**La fórmula es `O = G + H + I + J + K + L + M`**, exactamente lo que dice el instructivo.

El razonamiento contable, que es el que manda sobre la coincidencia numérica:

- **O es el total gravado NETO**: el valor de la compra sin impuesto.
- **N es el crédito fiscal** que esa compra genera, o sea el impuesto en sí.
- Sumar N dentro de O daría el monto con IVA incluido, que es otra magnitud y duplicaría el
  impuesto en el total del anexo.
- El propio instructivo lo delimita: "el total de las operaciones detalladas en las columnas
  comprendidas de la G a la M". La columna O no se incluye a sí misma ni incluye a N.

Las columnas H, I, K, L y M son `0.00` en un Comprobante de Crédito Fiscal porque
corresponden a internaciones e importaciones, que se declaran con Declaración de Mercancías
(tipo 12) o Mandamiento de Ingreso (tipo 13), no con un DTE de compra nacional. Aun así la
suma las incluye explícitamente en `build-anexo-row.ts`, para que la fórmula quede fiel al
instructivo el día que el libro incorpore esos tipos de documento.

Consecuencia en las muestras del proyecto: la v3 exporta `O = 176.99` (no 200.00) y la v4
`O = 144.00` (no 162.72).

**Reconciliación contra el DTE:** la coincidencia que sí debe cumplirse es
`O + N ≈ montoTotalOperacion`. Esa es la comprobación que hace la bandera `totalMismatch`, y
la que detecta documentos con totales internos inconsistentes.

---

## 5. Esquema

```prisma
enum DteParseStatus {
  PARSEADO
  DUPLICADO                // mismo [tenantId, codigoGeneracion] ya ingresado desde otro adjunto
  IGNORADO_TIPO            // DTE válido con tipoDte != "03"
  VERSION_NO_SOPORTADA     // identificacion.version fuera de {3, 4}
  NO_ES_DTE                // JSON válido que no es un sobre DTE
  JSON_INVALIDO
  ARCHIVO_DEMASIADO_GRANDE
  ARCHIVO_FALTANTE
  ERROR                    // campos faltantes/inválidos; errorDetail los enumera
}

/// Catálogo por tenant de emisores/receptores vistos en DTE (ADR-10.2).
model DteParty {
  id              String   @id @default(uuid())
  tenantId        String
  tenant          Tenant   @relation(fields: [tenantId], references: [id])
  nit             String   // sin guiones, tal cual el DTE (9 = DUI homologado, 14 = NIT)
  nrc             String?
  nombre          String
  nombreComercial String?
  codActividad    String?
  descActividad   String?
  departamento    String?
  municipio       String?
  distrito        String?
  complemento     String?
  telefono        String?
  correo          String?
  seenAsEmisor    Boolean  @default(false)
  seenAsReceptor  Boolean  @default(false)
  /// Defaults Anexo 3 (Q, R, S, T). Solo tienen sentido cuando actúa como receptor.
  defaultTipoOperacion  Int?
  defaultClasificacion  Int?
  defaultSector         Int?
  defaultTipoCostoGasto Int?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  emisorDocuments   PurchaseDocument[] @relation("DocEmisor")
  receptorDocuments PurchaseDocument[] @relation("DocReceptor")

  @@unique([tenantId, nit])
  @@index([tenantId, seenAsEmisor])
  @@index([tenantId, seenAsReceptor])
  @@map("dte_parties")
}

/// Ledger de parseo: una fila por adjunto JSON (ADR-10.1).
model DteParseResult {
  id               String            @id @default(uuid())
  tenantId         String
  tenant           Tenant            @relation(fields: [tenantId], references: [id])
  attachmentId     String            @unique
  attachment       Attachment        @relation(fields: [attachmentId], references: [id])
  status           DteParseStatus
  tipoDte          String?
  version          Int?
  codigoGeneracion String?
  documentId       String?           // PARSEADO y DUPLICADO apuntan al documento canónico
  document         PurchaseDocument? @relation(fields: [documentId], references: [id])
  errorDetail      String?
  parserVersion    Int
  parsedAt         DateTime          @default(now())

  @@index([tenantId, status])
  @@index([documentId])
  @@map("dte_parse_results")
}

model PurchaseDocument {
  id           String     @id @default(uuid())
  tenantId     String
  tenant       Tenant     @relation(fields: [tenantId], references: [id])
  attachmentId String     @unique   // archivo fuente canónico
  attachment   Attachment @relation(fields: [attachmentId], references: [id])
  emailId      String
  accountId    String               // desnormalizado para el filtro por cuenta

  // identificacion
  version          Int
  ambiente         String
  tipoDte          String
  numeroControl    String
  codigoGeneracion String           // con guiones, tal cual se emitió; el export los quita
  tipoModelo       Int
  tipoOperacion    Int
  tipoContingencia Int?
  motivoContin     String?
  fecEmi           DateTime @db.Date
  horEmi           String
  tipoMoneda       String

  // partes: FK al catálogo + snapshot
  emisorId                  String
  emisor                    DteParty @relation("DocEmisor", fields: [emisorId], references: [id])
  emisorNit                 String
  emisorNrc                 String?
  emisorNombre              String
  emisorNombreComercial     String?
  emisorCodActividad        String?
  emisorTipoEstablecimiento String?  // solo v3
  emisorCodEstable          String?
  emisorCodPuntoVenta       String?
  receptorId                String
  receptor                  DteParty @relation("DocReceptor", fields: [receptorId], references: [id])
  receptorNit               String
  receptorNrc               String?
  receptorNombre            String
  receptorNombreComercial   String?

  // resumen normalizado (v3 ivaRete1/ivaPerci1/reteRenta ≡ v4 ivaRete/ivaPerci)
  totalNoSuj          Decimal @db.Decimal(18, 8)
  totalExenta         Decimal @db.Decimal(18, 8)
  totalGravada        Decimal @db.Decimal(18, 8)
  subTotalVentas      Decimal @db.Decimal(18, 8)
  descuNoSuj          Decimal @db.Decimal(18, 8)
  descuExenta         Decimal @db.Decimal(18, 8)
  descuGravada        Decimal @db.Decimal(18, 8)
  porcentajeDescuento Decimal @db.Decimal(18, 8)
  totalDescu          Decimal @db.Decimal(18, 8)
  subTotal            Decimal @db.Decimal(18, 8)
  ivaRetenido         Decimal @db.Decimal(18, 8) @default(0)
  ivaPercibido        Decimal @db.Decimal(18, 8) @default(0)
  retencionRenta      Decimal @db.Decimal(18, 8) @default(0)
  ivaCreditoFiscal    Decimal @db.Decimal(18, 8) @default(0)  // resumen.tributos[codigo="20"].valor
  montoTotalOperacion Decimal @db.Decimal(18, 8)
  totalNoGravado      Decimal @db.Decimal(18, 8)
  totalPagar          Decimal @db.Decimal(18, 8)
  saldoFavor          Decimal @db.Decimal(18, 8)
  totalLetras         String
  condicionOperacion  Int
  numPagoElectronico  String?
  observaciones       String?

  selloRecibido        String?
  documentoRelacionado Json?
  otrosDocumentos      Json?
  ventaTercero         Json?
  extension            Json?
  apendice             Json?
  rawJson              Json

  // Overrides Anexo 3 (Q, R, S, T): null = usar default del receptor (ADR-10.5)
  anexoTipoOperacion  Int?
  anexoClasificacion  Int?
  anexoSector         Int?
  anexoTipoCostoGasto Int?
  anexoNota           String?
  classifiedById      String?
  classifiedAt        DateTime?

  parserVersion Int
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  items        PurchaseDocumentItem[]
  taxes        PurchaseDocumentTax[]
  payments     PurchaseDocumentPayment[]
  parseResults DteParseResult[]

  @@unique([tenantId, codigoGeneracion])   // idempotencia entre buzones del tenant
  @@index([tenantId, fecEmi])
  @@index([tenantId, receptorId, fecEmi])
  @@index([tenantId, emisorId, fecEmi])
  @@index([tenantId, accountId, fecEmi])
  @@index([tenantId, numeroControl])
  @@map("purchase_documents")
}

/// cuerpoDocumento[]
model PurchaseDocumentItem {
  id              String   @id @default(uuid())
  tenantId        String
  documentId      String
  document        PurchaseDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  numItem         Int
  tipoItem        Int
  numeroDocumento String?
  cantidad        Decimal  @db.Decimal(18, 8)
  codigo          String?
  codTributo      String?
  uniMedida       Int
  descripcion     String
  precioUni       Decimal  @db.Decimal(18, 8)
  montoDescu      Decimal  @db.Decimal(18, 8)
  ventaNoSuj      Decimal  @db.Decimal(18, 8)
  ventaExenta     Decimal  @db.Decimal(18, 8)
  ventaGravada    Decimal  @db.Decimal(18, 8)
  tributos        String[]                    // ["20"] o []
  psv             Decimal  @db.Decimal(18, 8)
  noGravado       Decimal  @db.Decimal(18, 8)

  @@unique([documentId, numItem])
  @@index([tenantId])
  @@map("purchase_document_items")
}

/// resumen.tributos[]
model PurchaseDocumentTax {
  id          String  @id @default(uuid())
  tenantId    String
  documentId  String
  document    PurchaseDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  codigo      String
  descripcion String
  valor       Decimal @db.Decimal(18, 8)

  @@unique([documentId, codigo])
  @@index([tenantId])
  @@map("purchase_document_taxes")
}

/// resumen.pagos[]
model PurchaseDocumentPayment {
  id         String  @id @default(uuid())
  tenantId   String
  documentId String
  document   PurchaseDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  position   Int
  codigo     String
  montoPago  Decimal @db.Decimal(18, 8)
  referencia String?
  plazo      String?
  periodo    Int?

  @@unique([documentId, position])
  @@index([tenantId])
  @@map("purchase_document_payments")
}
```

Relaciones inversas a agregar: `Tenant.dteParties`, `Tenant.dteParseResults`,
`Tenant.purchaseDocuments`; `Attachment.parseResult DteParseResult?` y
`Attachment.purchaseDocument PurchaseDocument?`. Las tablas hijas llevan `tenantId` aunque no
tengan FK a `Tenant`: la policy RLS necesita la columna.

### 5.1 Migración

```bash
pnpm prisma migrate dev --create-only --name purchase_book
# editar el SQL generado y anexar al final:
```

```sql
-- Grants explícitos para el rol de aplicación (mismo criterio que mail_providers)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "dte_parties", "dte_parse_results", "purchase_documents",
  "purchase_document_items", "purchase_document_taxes", "purchase_document_payments"
TO "maildte_app";

-- RLS FORCE + policy tenant_isolation en las 6 tablas (nullif como en
-- 20260902000000_fix_superadmin_rls_null_tenant)
ALTER TABLE "dte_parties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dte_parties" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "dte_parties"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), ''));
-- repetir para dte_parse_results, purchase_documents, purchase_document_items,
-- purchase_document_taxes, purchase_document_payments
```

```bash
pnpm prisma migrate dev
```

Verificación manual: conectarse con el rol `maildte_app` y ejecutar
`SELECT count(*) FROM purchase_documents;` sin `set_config` → debe devolver 0 filas.

Rollback: la migración es aditiva (6 tablas, 1 enum, 2 relaciones inversas); ninguna tabla
existente se altera. Revertir = `DROP TABLE ... CASCADE` + `DROP TYPE "DteParseStatus"`.

---

## 6. Pipeline de ingesta

```
SyncService.processMessage ──(commit)──▶ DteEnqueuer.enqueueParseBulk (cola "dte")
                                                    │
                                                    ▼  (worker)
                                          DteParseProcessor
                                                    │
                                                    ▼
                                DteIngestService.ingestAttachment(tenantId, attachmentId, { force })
                                                    │
        resolveSafe → readFile → JSON.parse → parseDte → withTenant { upsert partes; create doc; upsert ledger }
```

### 6.1 Parser puro — `src/purchase-book/parser/`

```ts
export const PARSER_VERSION = 1;

export type ParseOutcome =
  | { kind: 'parsed'; dte: ParsedCcf }
  | { kind: 'not-dte' }
  | { kind: 'unsupported-version'; version: number | null; tipoDte: string | null; codigoGeneracion: string | null }
  | { kind: 'ignored-type'; tipoDte: string; version: number; codigoGeneracion: string }
  | { kind: 'invalid'; errors: DteFieldError[]; tipoDte: string | null; version: number | null; codigoGeneracion: string | null };

export function parseDte(raw: unknown): ParseOutcome; // puro: sin IO, sin Nest, sin Prisma client
```

- Un solo parser con `readResumen(obj, version)` que aplica los alias v3/v4 (§3.2).
- Campos de retención/percepción ausentes → `0`. `tributos: null → []`.
- `ivaCreditoFiscal` = `valor` del tributo `"20"` en `resumen.tributos`; `0` si no existe.
- `observaciones` = `resumen.observaciones` (v4) o `extension.observaciones` (v3).
- Números JSON → `new Prisma.Decimal(String(n))` inmediatamente; strings numéricos
  (`/^-?\d+(\.\d+)?$/`) aceptados vía `toDecimal`. Ningún monto pasa por aritmética `number`.
- `ParsedCcf` refleja el `create` de Prisma (identificación, emisor, receptor, resumen
  normalizado, `items[]`, `taxes[]`, `payments[]`, `passthrough` con las secciones `Json?`).

### 6.2 Cola `dte` — `src/purchase-book/queue/`

- `dte-queue.constants.ts`: `DTE_QUEUE_NAME = 'dte'`, `DTE_PARSE_JOB_NAME = 'dte-parse'`,
  `DTE_QUEUE = Symbol('DTE_QUEUE')`,
  `DteParseJobData { tenantId; attachmentId; trigger: 'sync' | 'reprocess'; force?: boolean }`.
- `dte-queue.provider.ts`: clon de `syncQueueProvider` con `bullmqConnectionOptions`.
- `dte-queue.module.ts`: provider + `onModuleDestroy → queue.close()` + `DteEnqueuer`.
- `DteEnqueuer.enqueueParseBulk(data[])`: `queue.addBulk` con `jobId: dte:${attachmentId}`
  (dedup natural), `attempts: 3`, `backoff: { type: 'exponential', delay: 30_000 }`,
  `removeOnComplete: 500`, `removeOnFail: 500`.

### 6.3 Hook en `SyncService.processMessage`

- `tx.processedEmail.create` pasa a `select: { attachments: { select: { id: true, fileType: true } } }`.
- Tras el commit exitoso se encolan los adjuntos `JSON`. El `try/catch` alrededor del
  encolado hace `logger.warn` y continúa: **un Redis caído no marca el correo como ERROR**;
  el backfill (§6.6) recupera lo que no se encoló.
- `SyncModule` importa `DteQueueModule`.

### 6.4 `DteIngestService.ingestAttachment(tenantId, attachmentId, { force })` — worker

1. Cargar tenant (`slug`, `status`); si no está `ACTIVO`, salir con `info`.
2. `withTenant`: cargar adjunto con `where: { id, tenantId }` y
   `select { id, emailId, relativePath, fileType, sizeBytes, email: { accountId } }`.
   No encontrado → `warn` y retornar (no hay nada que reintentar). `fileType !== 'JSON'` → salir.
3. Idempotencia: si existe ledger con estado `PARSEADO | DUPLICADO | IGNORADO_TIPO`,
   `parserVersion === PARSER_VERSION` y `!force` → retornar sin IO.
4. Cap de tamaño doble: `sizeBytes > DTE_MAX_JSON_BYTES` → ledger `ARCHIVO_DEMASIADO_GRANDE`;
   luego `resolveSafe(tenantSlug, relativePath)` + `stat` y re-verificar. `ENOENT` →
   `ARCHIVO_FALTANTE`. `readFile` + `JSON.parse` en `try` → `JSON_INVALIDO`.
5. `parseDte(raw)` → mapear a estado. Solo `parsed` continúa.
6. **Una** transacción `withTenant`: `upsert` de emisor y receptor en `dte_parties`
   (`where: { tenantId_nit }`, `update` refresca nombre/dirección y marca `seenAsEmisor`/
   `seenAsReceptor`), `purchaseDocument.create` con `items/taxes/payments` anidados, `upsert`
   del ledger (`PARSEADO`, `documentId`). Violación única `tenantId_codigoGeneracion`
   (`isPrismaUniqueViolation`) → buscar el canónico y escribir `DUPLICADO`.
   Con `force` y documento existente para el adjunto: `update` de escalares + `deleteMany`
   de hijos + recreación, **sin tocar** `anexo*`, `classifiedById`, `classifiedAt`.
7. Todo resultado distinto de `parsed` escribe ledger y retorna normalmente (los fallos
   deterministas no se reintentan). Solo errores de infraestructura (BD, Redis, FS distinto de
   `ENOENT`, `resolveSafe` lanzando por ruta anómala se registra como `ERROR` sin reintento)
   propagan para que BullMQ reintente.
8. Logs pino con `{ tenantId, attachmentId, status, codigoGeneracion }`. **Nunca** el
   contenido del JSON, nombres, direcciones ni correos del DTE.

### 6.5 `DteParseProcessor` — worker

Clon de `SyncProcessor`: `new Worker<DteParseJobData>(DTE_QUEUE_NAME, ..., { connection,
concurrency: config.dteQueueConcurrency })`, listener `failed` con log, `close()` en
`onModuleDestroy`. Registrado en `PurchaseBookIngestModule`, importado **solo** por
`WorkerModule`. Sin cambios en `docker-compose`: el worker ya ejecuta `dist/worker.js`.

### 6.6 Backfill — `POST /purchase-book/reprocess` (ADMIN)

DTO: `accountId?` (uuid), `month?` (`YYYY-MM` → `ProcessedEmail.monthFolder`), `from?/to?`
(sobre `receivedAt`, con `rangeStart/rangeEnd`), `mode: 'missing' | 'failed' | 'all'`
(default `missing`), `cursor?` (id de adjunto), `limit` (default 1000, máximo
`PURCHASE_BOOK_REPROCESS_BATCH`).

- `missing`: adjuntos JSON sin fila en el ledger.
- `failed`: `missing` + estados `ERROR | JSON_INVALIDO | ARCHIVO_*` + filas con
  `parserVersion < PARSER_VERSION`.
- `all`: todos los JSON del filtro con `force: true` (preserva overrides).

Pagina por cursor `createdAt asc, id asc` como `ExportService.resolveCursorWhere`, **solo
encola** y responde `{ data: { enqueued, nextCursor } }`; el panel itera hasta
`nextCursor === null`. `@Throttle` 5/min. A diferencia de RUNBOOK §6, no toca IMAP ni
`lastUid`: es idempotente por construcción.

---

## 7. API — `api/v1/purchase-book` (módulo `src/purchase-book/`)

Reglas comunes: `@CurrentTenant()` en todo; `requireTenantId` → `FORBIDDEN_ROLE` para
SUPERADMIN; `tenantId` repetido en cada `where`; ids ajenos → 404
(`PURCHASE_DOCUMENT_NOT_FOUND`, `DTE_PARTY_NOT_FOUND`, `ACCOUNT_NOT_FOUND`); envelope
`{ data }` / `{ data, meta: { page, limit, total } }`; errores `{ statusCode, error, message }`
con mensaje en español; `Decimal` serializa como string; `fecEmi` como ISO a medianoche UTC.

| Método | Ruta | Rol | Contrato |
|---|---|---|---|
| GET | `/documents` | MIEMBRO, ADMIN | `ListPurchaseDocumentsDto`: `emisorId?` uuid, `receptorId?` uuid, `accountId?` uuid, `from?`/`to?` `YYYY-MM-DD` sobre `fecEmi`, `month?` `YYYY-MM` (prevalece sobre from/to), `q?` ≤ 80 (`contains` insensible en `numeroControl`, `codigoGeneracion`, `emisorNombre`), `classification?: all \| classified \| unclassified`, `page`, `limit` ≤ 200. Orden `fecEmi desc, createdAt desc`. Proyección sin `rawJson` ni hijos; incluye `effectiveClassification` y `receptor { id, nombre, nit }`. |
| GET | `/documents/summary` | MIEMBRO, ADMIN | Mismos filtros. `_sum` de `totalExenta`, `totalNoSuj`, `totalGravada`, `ivaCreditoFiscal`, `montoTotalOperacion`; `count`; `unclassifiedCount` (solo `fecEmi >= 2024-02-01`); `supplierIdAnomalies`; `totalMismatches` (`\|G+J+N − montoTotalOperacion\| > 0.01`); `jsonAttachmentsWithoutParse`. |
| GET | `/documents/:id` | MIEMBRO, ADMIN | Detalle con `items`, `taxes`, `payments`, `emisor`, `receptor`, ledger. `rawJson` **solo para ADMIN** (MIEMBRO recibe `null`). El archivo se descarga por el endpoint existente `/attachments/:id/download`. |
| PATCH | `/documents/:id/classification` | ADMIN | `UpdateClassificationDto`: `anexoTipoOperacion?`, `anexoClasificacion?`, `anexoSector?`, `anexoTipoCostoGasto?` (`Int \| null`, `@IsIn` catálogo; `null` limpia el override), `anexoNota?` ≤ 300. Registra `classifiedById = ctx.actor.id`, `classifiedAt`. |
| GET | `/parties` | MIEMBRO, ADMIN | `role: EMISOR \| RECEPTOR` obligatorio, `q?` (nombre/nit), `limit` ≤ 500, orden `nombre`. Incluye `documentCount`. |
| PATCH | `/parties/:id/defaults` | ADMIN | `UpdatePartyDefaultsDto`: los 4 defaults (`Int \| null`). Valida propiedad; no exige `seenAsReceptor`. |
| GET | `/catalogs` | MIEMBRO, ADMIN | Const maps con etiquetas en español (ADR-10.4). |
| GET | `/export` | MIEMBRO, ADMIN | Filtros de listado + `format: csv \| xlsx`, `header?` (solo xlsx), `allowUnclassified?`. `@Throttle` 10/min. Ver §8. |
| POST | `/reprocess` | ADMIN | Ver §6.6. `@Throttle` 5/min. |
| GET | `/parse-results` | ADMIN | Ledger paginado con `status?`, `accountId?`, `from?/to?` (`parsedAt`). Vista operativa de fallos con `errorDetail`, `attachmentId`, `emailId`. |

Decisión de roles: lectura y export para MIEMBRO y ADMIN; clasificación y defaults son
decisiones contables → ADMIN, coherente con `POST /accounts`.

Proyecciones en `purchase-book.projections.ts` con `satisfies Prisma.PurchaseDocumentSelect`,
como `ATTACHMENT_SELECT`. `buildPurchaseDocumentWhere(tenantId, dto)` es una función pura
exportada (patrón `buildExportWhere`).

---

## 8. Exportación — Anexo 3

### 8.1 Común a ambos formatos

- `buildAnexoRow(doc, receptor): AnexoCell[]` en `src/purchase-book/anexo/build-anexo-row.ts`
  es el **único** lugar con el mapeo de 21 columnas. Devuelve celdas tipadas
  `{ kind: 'text' | 'amount' | 'int'; value: string }` que renderizan los adaptadores CSV y XLSX.
- Helpers puros con spec propio: `splitSupplierId(nit)` (quita no dígitos; 14 → E; 9 → P;
  otra longitud → E tal cual + anomalía), `toAnexoAmount(decimal)` (`toDecimalPlaces(2,
  ROUND_HALF_UP).toFixed(2)`; negativo → `0.00` + anomalía), `formatFecEmi(date)`
  (`DD/MM/YYYY` con getters UTC), `stripHyphens(codigoGeneracion)`, `resolveClassification`.
- Columna O = **suma de G a M** calculada con `Decimal` sobre componentes ya redondeados, para
  que la verificación aritmética de Hacienda cierre fila por fila. N queda fuera: es el crédito
  fiscal generado por la compra, mientras que O es el total gravado **neto** (ver ADR-10.9).
  El resumen del export cuenta como anomalía las filas donde `O + N` no reconstruye
  `montoTotalOperacion`, que es la reconciliación real contra el DTE.
- `ExportPurchaseBookService.streamRows(ctx, dto, sink)`: cursor `fecEmi asc, id asc` en
  lotes de 500 con `select` mínimo + `receptor.default*`. **Nunca** `findMany` sin `take`.
- Antes de emitir headers: `count > PURCHASE_BOOK_EXPORT_MAX_ROWS` → `422 EXPORT_TOO_LARGE`;
  `unclassifiedCount > 0 && !allowUnclassified` → `422 PURCHASE_BOOK_UNCLASSIFIED`
  (`"Hay N compras sin clasificar (columnas Q–T). Clasifíquelas o exporte con allowUnclassified=true."`).
- Nombre: `sanitizeFilename(\`compras_${receptorNit ?? 'todos'}_${periodo}.${ext}\`)`,
  `Content-Disposition: attachment; filename="..."` (componentes ASCII).
- Error después de headers → `res.destroy(err)` (mismo patrón que el ZIP).

### 8.2 CSV — `src/purchase-book/export/anexo-csv.ts`

- Delimitador `;`, terminador `\r\n`, **sin fila de encabezado**, **UTF-8 sin BOM**. Un BOM
  antepone tres bytes a la columna A de la primera fila y rompe la validación de 10
  caracteres de la fecha; queda documentado y no se ofrece opción.
- Comillas solo si la celda contiene `;`, `"`, CR o LF; `"` se escapa como `""`.
- Neutralización de CSV injection en celdas de texto libre (columna F): si empieza por
  `=`, `+`, `-`, `@`, tabulador o CR se antepone `'`. Las columnas numéricas nunca son
  negativas (clamp a `0.00`), así que `-` no aparece en ellas.
- Montos con `.` y exactamente 2 decimales; fecha `DD/MM/YYYY`.
- Escritura directa a `res` con backpressure (`if (!res.write(chunk)) await once(res, 'drain')`),
  `Content-Type: text/csv; charset=utf-8`.

### 8.3 XLSX — `src/purchase-book/export/anexo-xlsx.ts`

- Mismas 21 columnas, sin encabezado por defecto; `header=true` agrega una fila legible
  para humanos (solo XLSX; Hacienda no la acepta).
- Tipos de celda: A, C, D, E, F, P, Q, R, S, T **texto** (preserva ceros a la izquierda de
  `03`, NIT y DUI; imposibilita fórmulas); B y U entero; G–O número con formato `0.00`.
  La fecha va como **texto** `DD/MM/AAAA`: una fecha Excel se convertiría en serial al
  re-guardar como CSV.
- Con `write-excel-file`: workbook en memoria acotado por `PURCHASE_BOOK_EXPORT_MAX_ROWS`,
  `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
  Con el fallback OOXML: streaming vía `archiver` (`zip.append` por parte).

### 8.4 Política de redondeo

`Decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)`; nunca truncación, nunca `Number`.
Hacienda trunca lo que exceda 2 decimales; al emitir exactamente 2, la truncación es un no-op
y el resultado coincide con cómo el emisor redondeó `resumen`. El detalle muestra también
`montoTotalOperacion` y el summary cuenta discrepancias mayores a 0.01.

---

## 9. Frontend (`web/`)

### 9.1 Rutas y navegación

- `web/src/App.tsx`, bajo `<TenantRoute>`: `libro-compras` → `LibroComprasPage`,
  `libro-compras/receptores` → `ReceptoresPage` (UI solo ADMIN; el backend es quien manda).
- `NAV_ITEMS` en `web/src/components/layout/AppLayout.tsx`:
  `{ to: '/libro-compras', label: 'Libro de compras', icon: <BookOpenText />, end: false }`.

### 9.2 `LibroComprasPage.tsx`

Orden vertical: encabezado → `FiltersPanel` → `SummaryStrip` → `ExportAnexoPanel` +
`ReprocessButton` → tabla (`md+`) / `RecordCard` (`< md`) → `Pagination`.

- **Filtros** (`gridClassName="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"`): Receptor
  (select desde `/parties?role=RECEPTOR`, "Todos los receptores"), Proveedor (select desde
  `/parties?role=EMISOR`, con `Input` de búsqueda encima si hay más de 50), Cuenta
  (`useAccounts`), Desde/Hasta (`type="date"`), Mes (`type="date"` recortado a `YYYY-MM`,
  como `ExportZipPanel`), Clasificación (todas / clasificadas / sin clasificar), Búsqueda
  (`q`, debounce 350 ms). Estado local de página con `latestRequestId` como `CorreosPage`.
- **`SummaryStrip`**: tiles Documentos, Gravado, Exento/No sujeto, IVA crédito fiscal,
  Total; badge destructivo "N sin clasificar" que al hacer clic activa el filtro
  `unclassified`. `aria-live="polite"`. `formatMoney` con
  `Intl.NumberFormat('es-SV', { style: 'currency', currency: 'USD' })` en `web/src/lib/format.ts`.
- **`ExportAnexoPanel`**: muestra el conteo del summary, botones "CSV (;)" y "XLSX" que
  llaman `apiDownload('/purchase-book/export?...')` con los filtros activos; checkbox
  "Exportar aunque haya compras sin clasificar" visible solo si `unclassifiedCount > 0`;
  toasts para `PURCHASE_BOOK_UNCLASSIFIED` y `EXPORT_TOO_LARGE`.
- **`ReprocessButton`** (solo ADMIN, `useAuthStore`): `AlertDialog` con selector de modo
  (faltantes / fallidos / todos) y explicación; itera `POST /reprocess` hasta
  `nextCursor === null`; toast con el total encolado.
- **Tabla `md+`**: Fecha, N° control, Proveedor (nombre + NIT/DUI en `text-xs`), Receptor,
  Gravado, IVA, Total, Clasificación (`ClassificationBadge`: cuatro códigos o "Sin
  clasificar"), chevron. **Móvil**: `RecordCard` con título proveedor, subtítulo número de
  control, campos Fecha / Receptor / Total y el badge.
- **`PurchaseDocumentSheet`** (`Sheet` lateral, ancho completo en móvil): secciones
  Identificación, Emisor, Receptor, Resumen (todos los montos), Ítems (tabla compacta /
  cards), Tributos, Pagos, `ClassificationEditor` (cuatro `Select` con etiquetas del
  catálogo, placeholder "Por defecto del receptor: 2 – Gasto", botón "Usar default",
  nota; guarda con `apiPatch`; deshabilitado con aviso para MIEMBRO), JSON crudo en
  `Collapsible` + `<pre>` solo ADMIN.
- **Estados**: skeletons de tabla y de cards; vacío con pista "Ejecute Reprocesar" cuando
  `jsonAttachmentsWithoutParse > 0`; toasts de error con `ApiError.message`.

### 9.3 `ReceptoresPage.tsx`

Tabla/cards de partes con `seenAsReceptor`: Nombre, NIT, Documentos, cuatro `Select` de
default inline con autosave (`apiPatch` + toast + actualización optimista en el store).
Párrafo explicando la precedencia (ADR-10.5). Enlace de regreso al libro.

### 9.4 Estado y tipos

- `web/src/stores/dte-parties-store.ts`: cache por rol, `fetchParties(role, force)`,
  `updatePartyDefaults(id, input)`.
- `web/src/stores/purchase-book-catalogs-store.ts`: carga única de `/catalogs`.
- `web/src/types/domain.ts`: `DteParseStatus`, `DteParty`, `PurchaseDocumentListItem`
  (montos `string`), `PurchaseDocumentDetail`, `EffectiveClassification`,
  `PurchaseBookSummary`, `PurchaseBookCatalogs`, `ListPurchaseDocumentsQuery`,
  `UpdateClassificationInput`, `UpdatePartyDefaultsInput`, `ReprocessInput`, `ReprocessResult`.
- `web/src/components/common/StatusBadges.tsx`: `ParseStatusBadge`, `ClassificationBadge`.

### 9.5 Accesibilidad y responsive

Labels en todos los controles; foco atrapado por `Sheet`; botones `min-h-11` en móvil;
tabla dentro de contenedor `overflow-x-auto`; paleta y tipografías existentes
(`web/src/index.css`), sin colores nuevos fuera de tokens.

---

## 10. Seguridad — checklist de la característica

1. RLS `FORCE` + `tenant_isolation` + `GRANT` en las 6 tablas; `tenantId` repetido en cada
   `where` e insertado en las tablas hijas.
2. El worker lee disco **solo** a través de `resolveSafe(tenantSlug, relativePath)` con
   `tenantSlug` tomado del tenant, nunca del adjunto ni del job.
3. Cap de tamaño doble (`sizeBytes` en BD y `stat`) contra `DTE_MAX_JSON_BYTES`;
   `JSON.parse` en `try`; sin merge/spread del JSON crudo; acceso por `hasOwnProperty`;
   `rawJson` se guarda verbatim y nunca se deserializa a instancias de clase.
4. La API no devuelve rutas absolutas; el detalle expone `attachmentId` y la descarga usa el
   endpoint existente, ya protegido.
5. CSV injection neutralizada en texto libre; montos ≥ 0; celdas XLSX de identificación
   tipadas como texto.
6. Export con `@Throttle`, cap de filas, cursor con backpressure, filename por
   `sanitizeFilename`, componentes ASCII.
7. Reprocess: ADMIN, `@Throttle`, cap de lote, solo encola; el job revalida tenant activo y
   propiedad del adjunto al ejecutarse.
8. `@Roles(Role.ADMIN)` en PATCH y POST; SUPERADMIN → `FORBIDDEN_ROLE`; `rawJson` solo ADMIN.
9. DTOs con `whitelist` + `forbidNonWhitelisted`; `@IsIn` contra los catálogos; `q` acotado;
   uuid y fechas validadas por regex antes de construir `Date`.
10. Logs con ids, estados, `codigoGeneracion` y NIT (dato de negocio ya en BD); nunca
    nombres, direcciones, correos ni cuerpos JSON.
11. Dinero solo con `Prisma.Decimal`; `toDecimal` es el único punto de conversión desde JSON.
12. Auditoría de dependencias en Fase 0 y re-auditoría en Fase 7:
    `pnpm audit --prod --audit-level=moderate`, `pnpm why <dep>`, `pnpm licenses list --prod`.
    `exceljs` y `xlsx` prohibidos (§3.3).

---

## 11. Tests obligatorios

### 11.1 Unit (jest, sin BD, `*.spec.ts` junto al código)

Fixtures: copiar las dos muestras a `src/purchase-book/__fixtures__/ccf-v3.json` y
`ccf-v4.json` (jest usa `rootDir: src`; `resolveJsonModule` está activo).

| Spec | Casos mínimos |
|---|---|
| `parser/dte-parser.spec.ts` | v3 parsea (`ivaRete1 → ivaRetenido = 1.77`, `extension` capturada, `tipoEstablecimiento`); v4 parsea (`ivaRete → 0`, `distrito`, `observaciones` desde `resumen`); ítems y montos como `Decimal` (`.eq`); `tributos: null → []`; `tipoDte "01"` → `ignored-type`; `version 2` → `unsupported-version`; `{}`, array, string → `not-dte`; `resumen.totalGravada` faltante → `invalid` con ruta en español; `"176.99"` aceptado; clave `__proto__` no contamina (`({}).polluted === undefined`). |
| `anexo/split-supplier-id.spec.ts` | `"040522092"` → DUI; `"12171609731022"` → NIT; `"0614-020390-102-8"` → NIT 14; `"123"` → anomalía. |
| `anexo/amount.spec.ts` | `1.005 → "1.01"`, `1.004 → "1.00"`, `-0.5 → "0.00"`, `176.99115044 → "176.99"`, `0 → "0.00"`. |
| `anexo/resolve-classification.spec.ts` | override > default > `0` pre-2024-02 > vacío; origen reportado. |
| `anexo/build-anexo-row.spec.ts` | Muestra v3 → 21 celdas exactas: `19/03/2026`, `4`, `03`, `FC5B1AE107F142CAA7DAAB4F8A3381D2`, `""`, nombre, `0.00`, `0.00`, `0.00`, `176.99`, `0.00`, `0.00`, `0.00`, `23.01`, `200.00`, `040522092`, Q–T, `3`. Muestra v4 → `162.72` en O. |
| `export/anexo-csv.spec.ts` | delimitador `;`, `\r\n`, primer byte ≠ `0xEF`, comillas solo cuando hace falta, `"` duplicada, prefijo `'` ante `=SUM()`, `+`, `-`, `@`; línea completa de la muestra v4 igual a un literal esperado. |
| `export/anexo-xlsx.spec.ts` | smoke: 21 columnas, A1 texto, G1 numérico, formato `0.00`, encabezado solo con `header: true`. Con el fallback OOXML: descomprimir con `adm-zip` y verificar `sheet1.xml`. |
| `purchase-book.service.spec.ts` | `buildPurchaseDocumentWhere` (siempre `tenantId`; `month` prevalece; `q` en `OR`; filtro de clasificación); 404 cross-tenant; PATCH registra `classifiedById`; SUPERADMIN → `FORBIDDEN_ROLE`; export rechaza sin clasificar; reprocess encola `limit` ids y devuelve `nextCursor`. |
| `ingest/dte-ingest.service.spec.ts` | happy path en una sola `withTenant`; violación única → `DUPLICADO`; JSON inválido → ledger sin documento; no-03 → `IGNORADO_TIPO`; oversized → sin leer disco; `resolveSafe` lanza → `ERROR` sin reintento; `force` preserva `anexo*`. |
| `sync/sync.service.spec.ts` | encola solo JSON, no PDF; Redis caído → `warn` y el correo queda `PROCESADO`. |

### 11.2 e2e (`test/purchase-book.e2e-spec.ts`, Postgres real con RLS vía `maildte_app`)

Dos tenants sembrados con los fixtures en disco y sus `attachments`; ingesta ejecutada
llamando a `DteIngestService.ingestAttachment` directamente (camino del worker sin BullMQ).

- Listado filtrado por `receptorId` devuelve solo ese receptor.
- Aislamiento: tenant B no ve el documento de A (404 en detalle, 0 en listado).
- MIEMBRO `PATCH classification` → 403; ADMIN → 200 y el export refleja el override.
- SUPERADMIN → 403 `FORBIDDEN_ROLE`.
- Bytes del CSV: sin BOM, `\r\n`, 21 celdas por fila, E/P correctos.
- Export con pendientes → 422; con `allowUnclassified=true` → 200.
- `reprocess mode=missing` → `enqueued: 0` tras la ingesta.
- Mismo DTE en una segunda cuenta del tenant A → `DUPLICADO`, total del listado sin cambio.

### 11.3 Frontend

`pnpm --dir web lint` y `pnpm --dir web build` (tsc + vite) obligatorios. Smoke manual con
Playwright a 375 px y 1280 px: filtros, apertura del `Sheet`, edición de clasificación,
descarga CSV/XLSX, navegación por teclado. No se agrega vitest en esta iteración.

---

## 12. Fases

Gates comunes a **todas** las fases, en este orden y sin excepciones:

```bash
pnpm build          # sin warnings de TypeScript
pnpm lint           # --max-warnings 0
pnpm test
pnpm test:e2e       # desde la Fase 1 (la migración debe aplicar en maildte_test)
pnpm --dir web lint && pnpm --dir web build   # en la Fase 6 y en la Fase 7
pnpm audit --prod --audit-level=moderate      # en la Fase 0 y en la Fase 7
```

Rama: `feat/libro-compras` desde `main`. Un commit por fase, conventional commits, cuerpo del
commit con la justificación de dependencias nuevas (regla 3).

### Fase 0 — Auditoría de dependencias, fixtures y configuración (0.5 día)

Objetivo: decidir la librería XLSX con evidencia, dejar fixtures y variables de entorno listas.

Tareas:
1. `pnpm add -E write-excel-file` → `pnpm audit --prod --audit-level=moderate` →
   `pnpm why fflate` → `pnpm licenses list --prod`. Si hay hallazgo no resoluble, retirar la
   dependencia y adoptar el fallback OOXML (ADR-10.6). Registrar el veredicto aquí y en el
   cuerpo del commit.
2. Mover `DTE_FC5B1AE1-….json` y `DTE_0B4E2221-….json` a
   `src/purchase-book/__fixtures__/ccf-v3.json` y `ccf-v4.json`; mover
   `DETALLE DE COMPRAS.pdf` a `docs/reference/anexo3-detalle-compras.pdf`.
3. Variables en `src/config/env.validation.ts`, `src/config/app-config.service.ts` y
   `.env.example`:

| Variable | Default | Validación |
|---|---|---|
| `PURCHASE_BOOK_EXPORT_MAX_ROWS` | `20000` | entero ≥ 1 |
| `PURCHASE_BOOK_REPROCESS_BATCH` | `1000` | entero 1–5000 |
| `DTE_MAX_JSON_BYTES` | `2097152` | entero ≥ 1024 |
| `DTE_QUEUE_CONCURRENCY` | `4` | entero 1–16 |

DoD: gates comunes (sin cambio de comportamiento) + auditoría sin hallazgos atribuibles a la
dependencia nueva.
Rollback: `pnpm remove` de la dependencia; revertir el commit.

**Veredicto de la auditoría (ejecutada el 2026-09-07):** `write-excel-file@4.1.1` **adoptada**.

- `pnpm why write-excel-file --prod` → dependencia directa única; `pnpm why fflate --prod` →
  una sola versión en el árbol. Licencias MIT en ambas (`pnpm licenses list --prod`).
- `pnpm audit --prod --audit-level=moderate` reporta 17 vulnerabilidades (1 baja, 9 moderadas,
  7 altas). **Ninguna es atribuible a la dependencia nueva**: las rutas de las 16 advisories
  son `@nestjs/platform-express>multer` (4), `@nestjs/platform-express>body-parser>qs` (3),
  `@nestjs/config>lodash` (3), `@nestjs/common>file-type` (2), `@nestjs/core` (1),
  `archiver>archiver-utils>glob` (1) y `mailparser>html-to-text>deepmerge-ts` (1). Ninguna
  ruta menciona `write-excel-file` ni `fflate`. `git diff main -- package.json` confirma que
  el único cambio de `dependencies` es la línea `"write-excel-file": "4.1.1"`.
- **Deuda preexistente, fuera del alcance de este addendum:** esas 17 vulnerabilidades vienen
  del árbol de NestJS 10, `archiver` y `mailparser` y ya estaban en `main` antes de esta rama.
  Corregirlas exige subir NestJS de major (10 → 11, `multer` 1.x → 2.x) y evaluar `overrides`
  de `qs`, `lodash` y `glob`. Queda registrado como tarea de mantenimiento independiente; la
  Fase 7 vuelve a correr el audit para verificar que este feature siga sin sumar hallazgos.
- No se adoptó el fallback OOXML: la dependencia pasó la evaluación. El fallback sigue
  documentado en ADR-10.6 por si `write-excel-file` cambia de estado.

### Fase 1 — Esquema, migración y RLS (0.5 día)

Archivos: `prisma/schema.prisma`, `prisma/migrations/<ts>_purchase_book/migration.sql`.
Tareas: modelos de §5, relaciones inversas, migración `--create-only`, anexar GRANT + RLS,
`pnpm prisma migrate dev`, verificación manual como `maildte_app`.
DoD: gates comunes; `pnpm test:e2e` sigue verde.
Rollback: `DROP TABLE` de las 6 tablas + `DROP TYPE`.

### Fase 2 — Parser, catálogos y fila del Anexo (1 día)

Archivos nuevos (carpeta **pura**, sin imports de Nest ni de `PrismaService`):
`src/purchase-book/parser/{json-access,dte-parser,dte-parser.types}.ts`,
`src/purchase-book/anexo/{classification-catalogs,split-supplier-id,amount,resolve-classification,build-anexo-row}.ts`
y sus `*.spec.ts`.
DoD: gates comunes; todos los specs de §11.1 de estas carpetas verdes.

### Fase 3 — Ingesta: cola, worker, hook de sync, backfill (1 día)

Archivos nuevos: `src/purchase-book/queue/{dte-queue.constants,dte-queue.provider,dte-queue.module,dte-enqueuer}.ts`,
`src/purchase-book/ingest/{dte-ingest.service,dte-ingest.service.spec,dte-parse.processor,purchase-book-ingest.module}.ts`.
Modificados: `src/sync/sync.service.ts`, `src/sync/sync.module.ts`, `src/worker.module.ts`.
Tareas: §6.2–§6.5; el servicio de backfill de §6.6 se implementa aquí y se expone en la
Fase 4.
DoD: gates comunes; prueba manual con `pnpm start:worker:dev` sobre un adjunto de fixture
(ledger `PARSEADO` y documento creado); `docker compose` sin cambios.
Rollback: revertir el commit; las colas BullMQ vacías no dejan estado.

### Fase 4 — API (1 día)

Archivos nuevos: `src/purchase-book/{purchase-book.module,purchase-book.controller,purchase-book.service,purchase-book.service.spec,parties.controller,parties.service,parties.service.spec,purchase-book.projections}.ts`,
`src/purchase-book/dto/{list-purchase-documents,update-classification,list-parties,update-party-defaults,reprocess,list-parse-results}.dto.ts`,
`test/purchase-book.e2e-spec.ts`.
Modificado: `src/app.module.ts`.
DoD: gates comunes; e2e de listado, detalle, roles, tenancy y reprocess verdes.

### Fase 5 — Export CSV y XLSX (0.5–1 día)

Archivos nuevos: `src/purchase-book/export/{anexo-cells,anexo-csv,anexo-csv.spec,anexo-xlsx,anexo-xlsx.spec,export-purchase-book.service,export-purchase-book.service.spec}.ts`,
`src/purchase-book/dto/export-purchase-book.dto.ts`; ruta en `purchase-book.controller.ts`.
DoD: gates comunes; e2e de export; verificación manual: el XLSX abre en LibreOffice/Excel
sin aviso de reparación; el CSV visto en hexadecimal empieza por la fecha (sin BOM).

### Fase 6 — Frontend (1.5 días)

Archivos nuevos: `web/src/pages/{LibroComprasPage,ReceptoresPage}.tsx`,
`web/src/components/purchase-book/{SummaryStrip,ExportAnexoPanel,ReprocessButton,PurchaseDocumentSheet,ClassificationEditor}.tsx`,
`web/src/stores/{dte-parties-store,purchase-book-catalogs-store}.ts`.
Modificados: `web/src/App.tsx`, `web/src/components/layout/AppLayout.tsx`,
`web/src/types/domain.ts`, `web/src/lib/format.ts`, `web/src/components/common/StatusBadges.tsx`.
DoD: gates comunes + `web` lint y build; smoke Playwright a 375 px y 1280 px.

### Fase 7 — Documentación y revisión final (0.5 día)

1. Este addendum: marcar cada fase como implementada con "qué quedó" y desvíos.
2. `RUNBOOK.md` §9 "Libro de compras: backfill y reprocesamiento de DTE": bucle `curl` sobre
   `POST /purchase-book/reprocess`, lectura de `parse-results`, significado de `DUPLICADO`,
   filtros de log del worker por `attachmentId`.
3. `CLAUDE.md`: regla 27 (montos solo con `Prisma.Decimal`), regla 28 (el parseo de DTE vive
   únicamente en `src/purchase-book/parser`), regla 29 (el mapeo del Anexo vive únicamente en
   `build-anexo-row.ts`); anti-patrón "export sin cap de filas ni cursor"; agregar
   `pnpm --dir web build` al DoD.
4. `01-PRD-MailDTE.md` (Fase 2 → implementada), `03-ARQUITECTURA-TECNICA.md` (tabla de ADR),
   `docs/05-PLAN-IMPLEMENTACION.md` (nota en Fase 5).
5. Revisión de seguridad sobre el diff completo de la rama y re-ejecución de
   `pnpm audit --prod --audit-level=moderate`.
DoD: **todos** los gates verdes.

Estimación total: 6–7 días.

---

## 13. Riesgos y puntos abiertos

1. ~~**Columna O.**~~ **Resuelto el 2026-09-07** (ver ADR-10.9): es la suma de G a M, sin N.
2. **Retenciones.** `ivaRetenido` e `ivaPercibido` no alteran O (se liquidan aparte).
3. **Identificación del proveedor con longitud distinta de 9 o 14** (proveedores del
   exterior, emisores mal formados): se exporta en E tal cual con contador de anomalías en el
   summary. Un override manual (`anexoSupplierIdOverride`) queda para una iteración futura.
4. **Documentos previos a noviembre 2022** (número de control en D): no aplica, la ingesta solo
   ve JSON de DTE.
5. **`rawJson` duplica la huella** (disco + jsonb). Aceptable (3–10 KB por documento); no
   cuenta contra `maxStorageBytes`, que mide solo archivos en disco.
6. **Concurrencia.** `DTE_QUEUE_CONCURRENCY` (4) y la concurrencia del sync (3) comparten el
   pool de Prisma del worker; el default es moderado y la variable está documentada.
7. **Cambios de parser.** Subir `PARSER_VERSION` y ejecutar `reprocess mode=failed`; las
   filas con versión anterior se re-parsean preservando overrides.
8. **`write-excel-file` genera en memoria.** Acotado por `PURCHASE_BOOK_EXPORT_MAX_ROWS`
   (20 000 filas × 21 columnas ≈ pocos MB). El fallback OOXML es streaming puro si un tenant
   lo necesitara.
9. **Notas de crédito y débito (`05`/`06`)** afectan el total de compras del período según el
   instructivo (suman ND, restan NC). El esquema las registra como `IGNORADO_TIPO`; su
   incorporación al libro es el siguiente addendum natural.

---

## 14. Registro de implementación

| Fase | Estado | Fecha | Notas |
|---|---|---|---|
| 0 | ✅ implementada | 2026-09-07 | `write-excel-file@4.1.1` adoptada (auditoría sin hallazgos propios); fixtures en `src/purchase-book/__fixtures__/`; PDF en `docs/reference/`; 4 variables de entorno. |
| 1 | ✅ implementada | 2026-09-07 | 6 tablas + enum `DteParseStatus`; migración `20260908035947_purchase_book` con GRANT y RLS FORCE escritos a mano. Aislamiento verificado con el rol `maildte_app` (0 filas sin contexto, sin fuga entre tenants). |
| 2 | ✅ implementada | 2026-09-07 | Parser puro v3/v4 (`parseDte`, `PARSER_VERSION` 1), helpers de acceso JSON, catálogos MH y `buildAnexoRow` con las 21 columnas. 93 tests nuevos. Carpeta verificada sin imports de Nest ni Prisma service. |
| 3 | ✅ implementada | 2026-09-07 | Cola `dte`, `DteEnqueuer`, `DteIngestService`, `DteParseProcessor` y hook en `SyncService.processMessage`. 29 tests nuevos. El backfill se expone en la Fase 4. |
| 4 | ✅ implementada | 2026-09-07 | API `api/v1/purchase-book/*`: listado con filtros, resumen, detalle, clasificación, partes, catálogos, ledger y reprocesamiento. 65 tests unitarios + 37 e2e. |
| 5 | pendiente | | |
| 6 | pendiente | | |
| 7 | pendiente | | |
