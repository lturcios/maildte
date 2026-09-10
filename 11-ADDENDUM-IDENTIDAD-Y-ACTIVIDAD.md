# Addendum 11 — Identidad del contribuyente y segmentación por actividad económica

**Estado:** borrador para revisión. No implementado.
**Origen:** dos hallazgos en el primer despliegue del Addendum 10 en producción (2026-09-09).
**Depende de:** Addendum 10 (libro de compras), ya en `main`.

---

## 1. Los dos problemas

### 1.1 Un contribuyente aparece como dos receptores

Datos reales del VPS, tenant `wendy-cocar`:

```
nombre                      | nit            | nrc     | docs | docs_con_nrc | nrc_distintos
JOSE WALTER CRUZ MARAVILLA  | 022560911      | 1435153 |    7 |            7 |             1
JOSE WALTER CRUZ MARAVILLA  | 11022205761034 | 1435153 |  849 |          849 |             1
```

Es **la misma persona**. Unos proveedores la identifican con el NIT de 14 dígitos y otros con el
NIT homologado al DUI, de 9. `DteParty` se identifica por `@@unique([tenantId, nit])`
(`prisma/schema.prisma:334`) y el NIT entra crudo desde el JSON, sin normalizar
(`parser/dte-parser.ts:137` → `ingest/dte-ingest.service.ts:395`). Dos identificadores, dos filas.

**No es un problema de formato.** Quitar guiones no lo arregla: `022560911` y `11022205761034` son
números distintos, ambos válidos, del mismo contribuyente.

**Por qué importa, y es fiscal.** Desde el Addendum 10 el export del Anexo 3 exige un único
`receptorId`. Con la identidad partida, exportar un receptor **deja las compras del otro fuera de
la declaración**, sin error y sin aviso, con un archivo que parece completo. En el caso de arriba:
exportar la fila de 14 dígitos declara 849 documentos y **omite 7**.

**Lo que NO está en riesgo.** El identificador del receptor no aparece en ninguna de las 21
columnas del Anexo 3 — las columnas E y P llevan el identificador del *proveedor*
(`anexo/split-supplier-id.ts`). Unificar la identidad del receptor **no cambia ningún dato
declarado**: cambia qué filas entran al archivo, no qué dice cada fila.

### 1.2 La actividad económica del receptor se pierde documento a documento

`PurchaseDocument` guarda `emisorCodActividad` pero **no** `receptorCodActividad` ni
`receptorDescActividad` (`prisma/schema.prisma:392-407`). La actividad del receptor solo vive en
`DteParty`, y el upsert la sobrescribe con cada documento: queda la del último ingresado.

Una empresa con varias actividades quiere segmentar sus compras por actividad. Hoy ese dato **ya se
está descartando** en cada ingesta: antes de exponerlo hay que dejar de perderlo.

> **Leído con los datos de producción (2026-09-09):** dejar de perder el dato era correcto, pero el
> dato **no responde la pregunta de la segmentación**. Lo escribe el emisor, no el receptor. Ver la
> revisión obligatoria al inicio de la fase 3.

**Implicación en la clasificación Q–T.** `resolveClassification()` resuelve hoy con la precedencia
`override del documento > default del receptor > sin clasificar`. Si una empresa segmenta por
actividad, sus defaults no son por receptor sino **por receptor y actividad**.

---

## 2. Decisión de identidad — CERRADA

Evidencia de producción (2026-09-09, tenants `wendy-cocar` y `rosa-alvarez`, 857 documentos):
el NRC está presente en el **100%** de los documentos y es **el mismo** en las dos partes del
contribuyente partido.

**Decisión: clave canónica en cascada, con el NRC arriba.**

```
canonicalKey = nrc normalizado    (si está presente)
             | nit de 14 dígitos  (si no)
             | dui de 9 dígitos   (si no)
```

**Por qué no NRC a secas, si la data dice que siempre está.** "Está en el 100% de estos 857
documentos" no es "está siempre": `receptorNrc` es `String?` en el esquema y el parser lo lee con
`getOptionalString`. Si el NRC fuera obligatorio, el primer proveedor que lo omita **haría fallar
la ingesta de ese documento entero** — cambiaríamos un problema de agrupación por uno de pérdida de
datos. La cascada hace que un NRC ausente degrade en vez de reventar. Con la data actual, la rama
del NRC resuelve prácticamente siempre; las otras dos son la red.

**Normalización.** El NRC se normaliza antes de usarse como clave: solo dígitos, sin ceros a la
izquierda. `splitSupplierId()` (`anexo/split-supplier-id.ts`) ya hace algo equivalente para el
identificador del proveedor; la lógica se extrae a un helper compartido en lugar de duplicarse.

**Consecuencia de esquema.** `@@unique([tenantId, nit])` deja de ser la identidad: un contribuyente
puede tener varios NIT/DUI. La unicidad pasa a `@@unique([tenantId, canonicalKey])` y los
identificadores vistos se conservan como datos de la parte, no como su clave.

---

## 3. Alcance propuesto

### Fase 1 — Capturar lo que hoy se pierde

Aditiva, reversible, sin tocar identidades. Valor inmediato.

1. Agregar a `PurchaseDocument`: `receptorCodActividad String?` y `receptorDescActividad String?`,
   en simetría con `emisorCodActividad`.
2. Persistirlos en `DteIngestService` (`ingest/dte-ingest.service.ts:267-270`). El parser **ya los
   extrae** en `parseParty`: hoy se descartan al armar el documento.
3. Subir `PARSER_VERSION` y correr el backfill en modo `failed` (RUNBOOK §9) para poblar el
   histórico.
4. Agregar `canonicalKey` a `DteParty` **sin** cambiar todavía la clave única, para observar la
   data real antes de migrar.

**Gate:** consulta que muestre, por contribuyente, cuántas actividades distintas aparecen y con qué
identificadores lo referencian sus proveedores. Implementada en el RUNBOOK §9.b.

#### Desvíos de lo implementado respecto de este texto (2026-09-09)

1. **No se agregó la columna `dui` a `DteParty`.** El punto 4 la pedía junto con `canonicalKey`.
   Separar los `nit` que ya existen en `nit`/`dui` obliga a decidir cómo se migran las filas
   actuales, que es trabajo de la fase 2, y hoy la longitud ya distingue los dos casos (14 vs 9)
   tanto en `splitSupplierId()` como en `resolveCanonicalKey()`. Se agregó solo `canonicalKey`.
2. **Hubo que arreglar el re-parseo sin `force` para que el punto 3 fuera posible.** `mode=failed`
   encola los adjuntos con `parserVersion` anterior **sin** `force` (solo `all` fuerza), pero
   `DteIngestService.persist()` buscaba el documento existente únicamente cuando venía `force`: un
   documento ya `PARSEADO` se iba por `create` contra el `attachmentId` único y moría con un P2002
   que no es un duplicado entre buzones, así que se propagaba y el adjunto quedaba con la versión
   vieja tras tres reintentos. Verificado contra Postgres antes y después del arreglo. La decisión
   de crear o actualizar pasó a depender de si este adjunto ya produjo un documento, que es de lo
   que siempre dependió; `force` sigue gobernando solo el early-exit de `hasTerminalResult()`. Sin
   esto, subir `PARSER_VERSION` no repuebla nada y la fase 1 no tiene efecto sobre el histórico.

#### Resultado del gate (producción, 2026-09-09)

Desplegada la fase 1 y corrido el backfill en modo `failed`, la fase queda **cerrada**. Cuatro
mediciones, y lo que cada una decide sobre lo que viene:

| Medición | Resultado | Qué decide |
|---|---|---|
| Documentos con `parserVersion >= 2` | 862/862 (`wendy-cocar`), 1/1 (`rosa-alvarez`) | El histórico quedó reprocesado. |
| Documentos con `receptorCodActividad` | **862/862** | El dato viene en el 100% de los DTE. Se estaba descartando en cada ingesta desde el primer día. |
| Partes sin `canonicalKey` | **0** | La cascada NRC > NIT-14 > DUI-9 cubre toda la producción. La fase 2 no necesita un cuarto nivel ni revisión manual previa. |
| Grupos con `partes > 1` | **1** | Una sola fusión pendiente, y es la del §1.1. El script de la §4 se estrena contra el caso más simple posible. |

El contribuyente partido es el conocido: JOSE WALTER CRUZ MARAVILLA, NRC `1435153`, referenciado por
sus proveedores como `11022205761034` y como `022560911`, con 862 documentos entre las dos partes.

**El backfill hubo que correrlo dos veces, y la primera mintió.** Reportó 968 trabajos encolados y
reprocesó 419 documentos de 862. Causa: el `jobId` es determinístico (`dte-<attachmentId>`) y
`DteEnqueuer` usa `removeOnComplete: 500`, así que los 500 registros de job retenidos del backfill
del Addendum 10 conservaban esos mismos ids — y **BullMQ ignora en silencio un `add` cuyo `jobId` ya
existe**, devolviendo el job viejo, ya completado. `enqueueParseBulk` devuelve `targets.length` sin
mirar lo que aceptó `addBulk`, así que el número del reporte no significaba nada. Se destrabó
liberando los ids huérfanos en Redis y repitiendo el backfill (520 restantes). El arreglo de fondo va
aparte, con su diagnóstico en el RUNBOOK §9: la firma de esta falla es **`llen bull:dte:wait` en 0 con
`con_parser_2 < documentos`**, que no parece un error en ninguna parte.

### Fase 2 — Unificar la identidad

1. Migración: `canonicalKey` calculada para las filas existentes, y `@@unique([tenantId,
   canonicalKey])` en reemplazo de `@@unique([tenantId, nit])`.
2. Resolución de identidad en la ingesta con la cascada de la sección 2.
3. **Script de fusión** (detalle en §4).
4. Vista de ADMIN que liste las partes candidatas a fusión con su evidencia (mismo NRC, mismo
   nombre) y permita confirmarlas. Aunque la resolución nueva sea automática, **la fusión del
   histórico se confirma a mano**: es un cambio contable.
5. **Guarda de export**: si un receptor tiene partes hermanas sin fusionar, el export del Anexo 3
   lo advierte **antes** de generar el archivo. Sin esto seguimos exportando declaraciones
   incompletas en silencio, que es el problema que originó este addendum.

**Gate:** un test que, con dos partes del mismo contribuyente, verifique que el export las incluye
a las dos **o falla explícitamente**. Nunca que exporte una y omita la otra.

### Fase 3 — Segmentación por actividad

#### REVISIÓN OBLIGATORIA antes de implementar (2026-09-09)

Los datos de la fase 1 **invalidan la premisa de esta fase tal como está escrita.** Distribución
real de `receptorCodActividad` en los 862 documentos del único contribuyente con más de una
actividad:

| Código | Descripción | Documentos | Proveedores distintos |
|---|---|---|---|
| `56101` | RESTAURANTES | 561 | **26** |
| `56107` | Actividades varias de restaurantes | 290 | **2** |
| `47219` | Venta al por menor de alimentos n.c.p. | 8 | 1 |
| `10005` | Otros | 3 | 1 |

No son cuatro actividades: es **una actividad con cuatro etiquetas**. La columna que lo delata es la
de proveedores. Veintiséis proveedores coinciden en `56101`; los 290 documentos de `56107` —volumen
suficiente para parecer legítimo— vienen de **dos** proveedores que sistemáticamente eligen otro
código para el mismo restaurante; los otros dos códigos son un proveedor cada uno, y uno de ellos se
llama literalmente "Otros".

**La razón es conceptual, no un problema de calidad de datos.** `receptorCodActividad` lo escribe el
**emisor**, copiándolo del registro de Hacienda al facturar. Responde "cómo está inscripto el
comprador", no "a qué actividad del comprador corresponde esta compra". El proveedor no puede
responder la segunda: no sabe a qué unidad de negocio va lo que vende. Un contribuyente con varias
actividades inscritas recibe códigos distintos según cuál eligió cada emisor, y esa elección no
guarda relación con el destino de la compra.

Implementar el filtro sobre este campo partiría el libro de un solo restaurante en cuatro pedazos
sin significado contable. El punto 4 (defaults Q–T por receptor+actividad) hereda el mismo vicio, y
con más consecuencia: haría depender la clasificación del Anexo 3 de qué código eligió el
proveedor.

**Qué sobrevive de la fase.** La necesidad es real — el cliente opera varias unidades de negocio y
necesita segmentar sus compras. Lo que no sirve es la fuente del dato. La decisión de qué fuente
usar queda **abierta** (§7.4); hasta cerrarla, los puntos 1, 2 y 4 no se implementan. El punto 3
(rótulo del export parcial) es independiente de la fuente y se mantiene tal cual.

El campo capturado en la fase 1 **no se descarta**: es la evidencia que permitió detectar esto, sirve
para control de calidad de lo que declaran los proveedores, y es un candidato razonable a *sugerencia*
por defecto — nunca a criterio de segmentación.

**Criterio contable confirmado por el usuario (2026-09-09):** se presenta **un solo libro de
compras por contribuyente**, con independencia de la actividad económica a la que se atribuya cada
compra. La segmentación por actividad es una necesidad de consulta y de contabilidad interna, **no
una forma de presentación**.

1. Filtro por `receptorCodActividad` en el listado y en el resumen.
2. Selector en el panel alimentado por las actividades realmente presentes en los documentos de ese
   receptor, no por un catálogo.
3. **Rótulo del export parcial — dos mitades, y las dos hacen falta.**
   - **El archivo:** un export filtrado por actividad lleva el código de actividad en el nombre
     (siempre 5 dígitos). Un export sin filtro de actividad **no lleva sufijo**: la ausencia de
     sufijo sigue significando "contribuyente completo".
     ```
     compras_1435153_2026-05.csv            <- completo, presentable
     compras_1435153_2026-05_act47411.csv   <- parcial, de trabajo
     ```
     El identificador del nombre pasa a ser el **de la clave canónica** (§2), no el NIT. Ver §7.1.
   - **El momento:** con el filtro de actividad activo, el panel dice explícitamente que ese
     archivo es un export de trabajo y no el Anexo 3 presentable.

   **Por qué las dos.** Un nombre de archivo es una guarda débil: está a un `rename` de distancia
   de que alguien presente un parcial como si fuera el completo. El nombre marca el archivo; la UI
   marca el momento en que se toma la decisión. Ninguna de las dos sola alcanza.

   El CSV no admite una marca interna: el instructivo exige exactamente las 21 columnas, sin
   encabezado ni BOM. El nombre y la UI son toda la superficie disponible.
4. Defaults Q–T por receptor **y actividad**: extender `resolveClassification()` a
   `override del documento > default por receptor+actividad > default por receptor > sin
   clasificar`. Es el cambio de mayor superficie del addendum y toca la regla 30 de `CLAUDE.md`.

### Fase 4 — Clasificación masiva sobre el filtro activo

Hoy las columnas Q–T se clasifican documento por documento. Con cientos de compras de un mismo
proveedor y del mismo tipo, eso es inviable: el contador necesita aplicar un valor a todo lo que
está viendo.

**Alcance:** un endpoint de ADMIN que aplica **un solo valor de una sola columna** a todos los
documentos del filtro activo. Cuatro columnas, cuatro operaciones independientes: el usuario elige
qué columna toca y con qué valor. No se aplican las cuatro juntas, porque casi nunca se deciden
juntas.

**¿Sobrescribe lo ya clasificado? — CERRADA (2026-09-09): solo vacíos por defecto.**

- **Default "solo vacíos"**: la operación llena únicamente los documentos que tienen esa columna
  sin valor. Un contador que ya clasificó 20 documentos a mano no pierde ese trabajo con un clic
  distraído.
- **Sobrescribir** exige un segundo control explícito en la UI, que además informe **cuántos
  documentos ya clasificados va a pisar** antes de confirmar. Lo destructivo se elige, no se
  tropieza.

**Restricciones no negociables:**

- **ADMIN**, igual que la clasificación individual. Es una decisión contable.
- **Confirmación con el conteo exacto** antes de escribir: "vas a clasificar 847 compras". Un
  filtro más ancho de lo que el usuario cree es el modo de falla obvio de esta funcionalidad.
- **Tope de filas y recorrido por lotes**, igual que el export (anti-patrón de `CLAUDE.md`): nada
  de un `updateMany` sobre un filtro sin acotar.
- Registrar `classifiedById` y `classifiedAt`, que ya existen en `PurchaseDocument`: tiene que
  quedar quién clasificó en masa y cuándo.
- Scoping por tenant con `withTenant`, como todo lo demás.
- **Reutilizar `buildPurchaseDocumentWhere`.** El filtro que se aplica tiene que ser exactamente el
  que el usuario está viendo; una segunda definición del filtro es una forma garantizada de
  clasificar documentos que no estaban en pantalla.

**Gate de la fase:** un test que verifique que la operación toca **exactamente** los documentos del
filtro y ninguno más, y otro que verifique que en modo "solo vacíos" no pisa un override existente.

---

## 4. El script de fusión

`scripts/merge-dte-parties.ts`, mismo patrón que `scripts/backfill-purchase-book.ts`: corre en el
host con `APP_DATABASE_URL`, recorre tenants, y **solo con flag explícito** (regla de `CLAUDE.md`
sobre migrar datos desde código de aplicación).

### Qué hace

1. Agrupa las partes por `(tenantId, canonicalKey)` y detecta los grupos con más de una fila.
2. Elige la **parte canónica**: la que más documentos tiene. Con empate, la de `createdAt` más
   antiguo.
3. Reasigna a la canónica, dentro de **una transacción por grupo**:
   - `purchase_documents.receptorId`
   - `purchase_documents.emisorId` — el mismo contribuyente puede haber quedado partido también
     del lado emisor.
4. Consolida en la canónica: los flags `seenAsEmisor` / `seenAsReceptor` con OR, y los
   identificadores vistos (`nit`, `dui`, `nrc`).
5. Consolida los defaults Q–T. **Regla ante conflicto:** gana la parte con más documentos, y el
   conflicto se **reporta** en la salida para que el contador lo revise. Nunca se mezclan
   silenciosamente cuatro columnas de dos criterios distintos.
6. Borra las partes absorbidas, **imprimiendo su contenido completo** en la salida para dejar
   registro. Con `canonicalKey` en su lugar no pueden volver a crearse: la ingesta las resuelve a
   la misma parte.

### Restricciones

- `--dry-run` **por defecto**. La fusión real exige `--apply`. Es un cambio contable sobre datos de
  clientes: el default seguro es no tocar nada.
- `--tenant=<slug|id>` para acotar. Recomendado para la primera corrida.
- Idempotente: dos corridas seguidas no rompen nada; la segunda no encuentra grupos.
- Un tenant que falla no aborta a los demás. Se marca su fila y el proceso termina distinto de
  cero, igual que el backfill.
- No toca IMAP, ni `lastUid`, ni el storage. Solo la base.
- Salida por tenant y por grupo fusionado, imprimiéndose a medida que avanza, para que una
  interrupción no borre el registro de lo ya hecho.

### Salida esperada para el caso conocido

```
Fusión de partes por identidad canónica — --dry-run (no se aplica nada)

  tenant wendy-cocar
    JOSE WALTER CRUZ MARAVILLA  nrc 1435153
      canónica : 11022205761034  (849 documentos)
      absorbe  : 022560911       (7 documentos)   -> 856 tras fusionar
  ------------------------------------------------------------------
  1 tenant, 1 grupo, 2 partes -> 1, 7 documentos reasignados
```

### Verificación posterior

```sql
-- No debe quedar ningún canonicalKey con más de una parte
SELECT "tenantId", "canonicalKey", count(*)
FROM dte_parties
GROUP BY "tenantId", "canonicalKey"
HAVING count(*) > 1;

-- El total de documentos del contribuyente no cambió
SELECT count(*) FROM purchase_documents WHERE "receptorId" = '<id de la canónica>';
```

---

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Fusionar dos partes que **no** son el mismo contribuyente | La fusión del histórico se confirma a mano y el script es `--dry-run` por defecto. El NRC compartido es evidencia fuerte, no prueba. |
| La migración de identidad rompe documentos ya clasificados | La clasificación Q–T vive en `purchase_documents`, no en la parte: reasignar `receptorId` no la pierde. Test antes de migrar. |
| Defaults Q–T en conflicto entre las dos partes | Gana la de más documentos y el conflicto se reporta. Nunca se mezcla en silencio. |
| Subir `PARSER_VERSION` reprocesa todo el histórico | El backfill en modo `failed` es idempotente y conserva los overrides Q–T (verificado en el Addendum 10). Correr en ventana de poco movimiento. |
| Un export parcial por actividad se presenta como si fuera el completo | Sufijo de actividad en el nombre **y** aviso en el panel. El export sin filtro conserva el nombre actual. |
| Hacer el NRC obligatorio y perder documentos que no lo traen | La cascada: el NRC es la primera opción, no la única. |

---

## 6. Lo que este addendum NO hace

- No toca el parser de montos ni el mapeo de las 21 columnas.
- No cambia la regla de un solo receptor por export: la refuerza.
- No cambia cómo se presenta el Anexo 3: sigue siendo uno por contribuyente y período.

---

## 7. Decisiones que quedan abiertas

1. **Identificador del nombre del archivo — CERRADA (2026-09-09): el de la clave canónica.**

   El nombre pasa a llevar el **NRC**, con la misma cascada de la §2 cuando falta:

   ```
   nombre = compras_<canonicalKey>_<periodo>[_act<codActividad>].<ext>
   canonicalKey = NRC normalizado | NIT-14 | DUI-9
   ```

   **Por qué no el NIT.** Un contribuyente puede tener dos NIT válidos (14 y 9 dígitos), y tras la
   fusión la parte canónica conserva el de la fila que tenía más documentos — es decir, el que
   decidió el accidente de qué proveedores facturaron más. Nombrar el archivo con eso es nombrarlo
   con una casualidad: con el reparto de proveedores al revés, el mismo contribuyente tendría otro
   nombre. El NRC no depende de nada de eso.

   **Consecuencia aceptada.** El nombre cambia respecto del Addendum 10
   (`compras_11022205761034_2026-05.csv` → `compras_1435153_2026-05.csv`). Se asume ahora, apenas
   desplegado y con pocos archivos emitidos, en lugar de arrastrar un identificador arbitrario.

   **El nombre no se autodescribe.** No lleva prefijo `nrc`/`nit`: las tres formas tienen
   longitudes distintas (NRC ~6-8, DUI 9, NIT 14) y no colisionan en la práctica. Si más adelante
   hace falta distinguirlas a simple vista, se agrega el prefijo sin romper nada.

2. **Criterio de fusión de los defaults Q–T** cuando las dos partes traen clasificaciones
   distintas: ¿gana la de más documentos, o se deja sin clasificar y que el contador decida?
4. **Fuente de la segmentación por actividad — ABIERTA, bloquea la fase 3.** El campo del DTE no
   sirve (ver la revisión de la fase 3). Las alternativas, sin decidir:
   - **Clasificación explícita por documento**, con la misma mecánica de los overrides Q–T
     (`override del documento > default > sin clasificar`) y la clasificación masiva de la fase 4
     como herramienta para que sea viable sobre cientos de compras. Es la única fuente que responde
     de verdad "a qué actividad corresponde esta compra", porque la contesta quien lo sabe. Cuesta
     trabajo del contador.
   - **Derivar del proveedor**: cada proveedor suele servir a una sola unidad de negocio. Barato y
     probablemente correcto en la mayoría de los casos, silenciosamente incorrecto en el resto.
   - **El código del DTE como sugerencia** de cualquiera de las dos anteriores, nunca como criterio.

   La decisión no es técnica: define cuánto trabajo manual acepta el contador a cambio de cuánta
   exactitud. Hay que preguntarla antes de diseñar la fase 3.
5. **Identidad del emisor.** Probablemente tiene el mismo problema, pero ahí no produce una
   declaración incorrecta: el anexo lleva el identificador del emisor tal cual y la regla E/P lo
   resuelve por longitud. Solo ensucia el listado de proveedores con filas repetidas. Fuera de
   alcance, anotado.
