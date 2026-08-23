# PRD — MailDTE Collector
**Sistema de descarga y archivo automático de adjuntos JSON/PDF desde múltiples cuentas de correo**

| Campo | Valor |
|---|---|
| Producto | MailDTE Collector |
| Versión documento | 1.0 |
| Fecha | Agosto 2026 |
| Autor | LTSOFT Ingeniería Informática |
| Estado | Aprobado para diseño técnico |

---

## 1. Visión del producto

MailDTE Collector es un servicio backend que monitorea de forma continua múltiples cuentas de correo electrónico, detecta correos con adjuntos JSON y PDF (típicamente Documentos Tributarios Electrónicos — DTE — emitidos por proveedores en El Salvador), descarga los archivos y los organiza automáticamente en una estructura de carpetas por cuenta y por mes, manteniendo un registro auditable de cada correo procesado.

### Problema que resuelve
Las empresas receptoras de DTE reciben cientos de facturas electrónicas por correo cada mes, en distintas cuentas (compras, contabilidad, sucursales). Hoy el proceso es manual: abrir cada correo, descargar el JSON y el PDF, renombrar, mover a carpetas. Esto es lento, propenso a errores, y dificulta la conciliación fiscal (F-07, anexos de IVA) y el respaldo documental exigido por el Ministerio de Hacienda.

### Propuesta de valor
- **Cero intervención manual**: los archivos aparecen organizados sin que nadie abra el correo.
- **Trazabilidad completa**: registro de remitente, fecha/hora de recepción, fecha de procesamiento y archivos extraídos por cada correo.
- **Multi-cuenta**: una sola instalación gestiona N cuentas de correo de la organización.
- **Archivo mensual**: estructura `cuenta → mes → archivos` alineada con los períodos de declaración fiscal.

## 2. Usuarios objetivo

| Perfil | Necesidad |
|---|---|
| Contador / auxiliar contable | Encontrar rápidamente todos los DTE recibidos en un período para conciliar el F-07 |
| Administrador del sistema | Dar de alta cuentas de correo, verificar que la sincronización funciona |
| Gerencia | Confirmar que existe respaldo documental completo de compras |
| Sistemas externos (Facturador SV, SAM) | Consumir los JSON descargados vía API o filesystem |

## 3. Alcance

### Incluido (MVP)
1. Gestión de N cuentas de correo vía IMAP (Gmail, Outlook/Microsoft 365, cPanel/hosting genérico).
2. Sincronización periódica automática (intervalo configurable, por defecto cada 5 minutos) y disparo manual.
3. Descarga exclusiva de adjuntos con extensión/MIME `JSON` y `PDF`; el resto se ignora.
4. Almacenamiento en estructura: `storage/{cuenta}/{YYYY-MM}/{json|pdf}/archivo`.
5. Registro en base de datos por correo procesado: Message-ID, remitente (nombre y dirección), asunto, fecha/hora de recepción, fecha/hora de procesamiento, cantidad y detalle de adjuntos, estado.
6. Idempotencia: un correo nunca se procesa dos veces (control por `Message-ID` + `UID` IMAP).
7. API REST para: CRUD de cuentas, consulta de correos procesados con filtros, listado/descarga de adjuntos, estadísticas y logs de sincronización.
8. Cifrado de credenciales de correo en reposo (AES-256-GCM).

### Incluido (Fase 2 — post-MVP)
- Panel web de administración (React) con dashboard de estadísticas.
- Parseo del contenido del JSON DTE (código de generación, NIT emisor, monto, tipo de documento) para búsqueda avanzada.
- Notificaciones (correo/webhook) ante fallos de sincronización.
- OAuth2 para Gmail/Microsoft 365 (además de app passwords).

### Excluido
- Envío de correos.
- Firma, validación o transmisión de DTE a Hacienda (eso es dominio de Facturador SV).
- Cliente de correo completo (no se leen cuerpos para mostrar al usuario, solo metadatos).
- Procesamiento de adjuntos distintos de JSON/PDF (XML, ZIP, imágenes quedan fuera del MVP; ZIP se evalúa en fase 2).

## 4. Funcionalidades priorizadas

| # | Funcionalidad | Prioridad |
|---|---|---|
| F-01 | Registro y gestión de cuentas IMAP | P0 |
| F-02 | Worker de sincronización periódica por cuenta | P0 |
| F-03 | Filtrado y descarga de adjuntos JSON/PDF | P0 |
| F-04 | Estructura de carpetas cuenta/mes | P0 |
| F-05 | Registro auditable de correos procesados | P0 |
| F-06 | Idempotencia y control de duplicados | P0 |
| F-07 | API de consulta con filtros (cuenta, rango de fechas, remitente, estado) | P1 |
| F-08 | Logs de sincronización y reintentos automáticos | P1 |
| F-09 | Estadísticas (correos/archivos por cuenta y mes) | P1 |
| F-10 | Panel web de administración | P2 |
| F-11 | Parseo de metadatos DTE del JSON | P2 |
| F-12 | Notificaciones de fallo | P2 |

## 5. Criterios de éxito

- 100% de los correos con adjuntos JSON/PDF de las cuentas configuradas quedan archivados sin intervención manual.
- 0 duplicados en el filesystem y en la base de datos.
- Un correo recibido queda procesado en menos de 10 minutos (intervalo de sync + procesamiento).
- Cualquier archivo del mes puede ubicarse en ≤ 3 clics/comandos gracias a la estructura de carpetas.
- Recuperación automática ante caídas de red o del proveedor IMAP (reintentos con backoff).

## 6. Restricciones y supuestos

- Las cuentas de correo permiten acceso IMAP (Gmail y Microsoft 365 requieren app password o OAuth2; se documenta el procedimiento de habilitación).
- El servicio corre en el VPS de LTSOFT (Docker + Nginx) junto al resto del ecosistema.
- El volumen estimado inicial es ≤ 5,000 correos/mes por cuenta; el diseño debe escalar a 10 cuentas sin cambios de arquitectura.
- El almacenamiento en disco crece ~1–2 GB/mes por cuenta en el peor caso; se define política de respaldo pero no de borrado (los DTE deben conservarse por exigencia fiscal).
- Zona horaria de referencia: `America/El_Salvador` (UTC−6) para el cálculo de la carpeta mensual.
