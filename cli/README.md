# maildte-pull

Agente cliente de línea de comandos para sincronizar localmente los DTE (JSON/PDF) archivados por **MailDTE Collector**, según RF-07 del addendum de exportación. Es un paquete pnpm independiente, sin dependencias de NestJS: solo necesita Node.js 20+ y acceso HTTP al servidor MailDTE.

## Instalación

```bash
cd cli
pnpm install
pnpm run build
```

Esto genera `dist/index.js`. Para usarlo como comando `maildte-pull` en tu PATH:

```bash
pnpm link --global
```

O invocalo directamente sin instalar globalmente:

```bash
node dist/index.js <comando> [opciones]
```

El resto de este documento asume que `maildte-pull` está en el PATH; si no, reemplazá `maildte-pull` por `node dist/index.js`.

## Configuración inicial

```bash
maildte-pull init
```

Te va a pedir, en orden:

1. **URL de la API** del servidor MailDTE (ej. `https://maildte.ltsoft.us/api/v1`).
2. **API Key** (la misma que usa el servidor para el header `X-Api-Key`).
3. **Carpeta destino** donde se van a guardar los archivos (por defecto `./maildte-data`).
4. **Cuentas a sincronizar**, elegidas de una lista que el CLI trae del servidor.

Esto genera `maildte.config.json` en el directorio actual, con permisos `600` (best-effort; en Windows los permisos POSIX no aplican igual, pero el archivo se crea de todas formas — no lo subas a ningún repositorio ni lo compartas, contiene la API key en texto plano).

## Comandos

### `maildte-pull sync`

Descarga solo los archivos **nuevos** desde el último cursor guardado por cuenta, verificando cada uno por SHA-256. El cursor de una cuenta **solo avanza si el 100% del lote se verificó correctamente** — si algún archivo falla, la próxima corrida vuelve a intentar todo el lote pendiente, no solo lo que falló.

Opciones:

| Flag | Efecto |
|---|---|
| `--all` | Ignora el cursor local: trae todo el historial disponible (los archivos que ya existen con hash válido se saltan igual). Siempre usa descarga por ZIP mensual. |
| `--account <email\|alias>` | Sincroniza solo esa cuenta (por defecto: todas las configuradas). |
| `--month YYYY-MM` | Filtra por mes de recepción. |
| `--dry-run` | Muestra qué se descargaría sin escribir nada ni tocar el estado local. |
| `--no-strip-tenant-prefix` | El servidor guarda cada archivo bajo `{tenantSlug}/{cuenta}/...`; por defecto el CLI omite ese primer segmento al escribir localmente (tu carpeta destino no necesita tu propio slug como raíz). Esta opción conserva la estructura exacta del servidor, slug incluido. |

Estrategia de descarga (automática, sin intervención):

- **≤ 200 archivos pendientes** → descargas individuales concurrentes (4 en paralelo).
- **> 200 archivos pendientes**, o `--all` → ZIP por lote mensual vía `/export/archive`.

Cada archivo se escribe de forma atómica (temporal + rename) y se verifica contra el SHA-256 del manifiesto; si no coincide, se reintenta hasta 3 veces antes de reportarlo como fallo.

### `maildte-pull verify`

Re-hashea todo el árbol local contra el manifiesto completo del servidor y reporta archivos faltantes o corruptos, **sin descargar nada**. Útil para auditorías periódicas independientes del `sync`.

```bash
maildte-pull verify [--account <email|alias>] [--no-strip-tenant-prefix]
```

### Código de salida

Todos los comandos devuelven `0` si todo salió bien y un código distinto de `0` si hubo al menos un fallo (archivo no verificado, faltante, corrupto). Esto permite que una tarea programada detecte fallos y alerte.

## Ejemplo de salida

```
$ maildte-pull sync

Cuenta: Compras (compras@ltsoft.us)
  Estrategia: descargas individuales (concurrencia 4)
  Nuevos: 12 | Ya existentes: 340 | Descargados: 12 | Fallidos: 0
  Tamaño descargado: 4.8 MB

Cuenta: Facturación (facturacion@ltsoft.us)
  Estrategia: ZIP por mes
  Nuevos: 812 | Ya existentes: 0 | Descargados: 812 | Fallidos: 0
  Tamaño descargado: 156.3 MB

Resumen general:
  Cuentas procesadas: 2
  Archivos descargados: 824
  Errores: 0

Listo, sin errores.
```

Con fallos:

```
$ maildte-pull sync
  Error: compras_ltsoft_us/2026-07/pdf/factura-042.pdf no se pudo verificar tras 3 intentos (hash no coincide (esperado ab12..., obtenido cd34...))

Cuenta: Compras (compras@ltsoft.us)
  Estrategia: descargas individuales (concurrencia 4)
  Nuevos: 5 | Ya existentes: 340 | Descargados: 4 | Fallidos: 1
  Tamaño descargado: 1.1 MB

Resumen general:
  Cuentas procesadas: 1
  Archivos descargados: 4
  Errores: 1

Terminado con errores. Revisá el detalle arriba.

$ echo $?
1
```

## Tarea programada

### Windows (`schtasks`)

Crear una tarea que corra `maildte-pull sync` todos los días a las 07:00, en la carpeta donde vive `maildte.config.json`:

```powershell
schtasks /Create /TN "MailDTE Pull" /TR "node \"C:\ruta\a\cli\dist\index.js\" sync" /SC DAILY /ST 07:00 /F
```

- `/TR` debe apuntar al `dist/index.js` compilado (no al `.ts`).
- El directorio de trabajo de la tarea determina dónde busca `maildte.config.json` y `.maildte-state.json`; si `schtasks` no respeta el cwd que necesitás, envolvé el comando en un `.bat`:

  ```bat
  @echo off
  cd /d "C:\ruta\donde\esta\maildte.config.json"
  node "C:\ruta\a\cli\dist\index.js" sync
  ```

  y apuntá `/TR` a ese `.bat`.
- Revisar el resultado: `schtasks /Query /TN "MailDTE Pull" /V /FO LIST` — el código de salida no cero indica que hubo fallos en la última corrida (ver sección "Código de salida").

### Linux / macOS (`cron`)

```bash
crontab -e
```

Agregar (corre todos los días a las 07:00):

```cron
0 7 * * * cd /ruta/donde/esta/maildte.config.json && /usr/bin/node /ruta/a/cli/dist/index.js sync >> /var/log/maildte-pull.log 2>&1
```

- `cd` antes del comando es necesario para que el CLI encuentre `maildte.config.json` en el directorio esperado.
- Redirigir a un log (`>>`) es importante: cron no guarda la salida por defecto, y ahí vas a ver los reportes de fallos si `sync` termina con código distinto de 0.
- Para alertar por fallo, envolvé el comando y chequeá `$?`:

  ```cron
  0 7 * * * cd /ruta/... && /usr/bin/node dist/index.js sync >> /var/log/maildte-pull.log 2>&1 || echo "maildte-pull falló" | mail -s "Alerta MailDTE" vos@ejemplo.com
  ```
