#!/usr/bin/env bash
#
# Respaldo diario: pg_dump comprimido + rsync incremental de STORAGE_ROOT.
# No detiene servicios: pg_dump es consistente en caliente (MVCC de Postgres)
# y StorageService escribe siempre de forma atómica (tmp -> fsync -> rename),
# así que rsync nunca puede copiar un archivo a medio escribir.
#
# Corre en el HOST del VPS (no dentro de un contenedor) — usa `docker exec`
# para llegar al contenedor de Postgres.
#
# Uso en cron (como el usuario que tiene permiso de `docker`):
#   0 3 * * * STORAGE_ROOT=/data/storage /opt/maildte/scripts/backup.sh >> /var/log/maildte-backup.log 2>&1
#
# Variables de entorno (todas con default salvo STORAGE_ROOT):
#   BACKUP_ROOT         Carpeta destino de los respaldos (default /var/backups/maildte)
#   RETENTION_DAYS      Días de retención de los dumps de BD (default 30)
#   STORAGE_ROOT         Carpeta real de storage del servicio (obligatoria)
#   POSTGRES_CONTAINER  Nombre del contenedor de Postgres (default maildte-postgres-1;
#                       verificar con `docker compose -f docker-compose.prod.yml ps`)
#   POSTGRES_USER       default maildte
#   POSTGRES_DB         default maildte

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/maildte}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STORAGE_ROOT="${STORAGE_ROOT:?Falta la variable de entorno STORAGE_ROOT}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-maildte-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-maildte}"
POSTGRES_DB="${POSTGRES_DB:-maildte}"

log() {
  printf '[%s] %s\n' "$(date -Iseconds)" "$1"
}

if [ ! -d "$STORAGE_ROOT" ]; then
  log "ERROR: STORAGE_ROOT ($STORAGE_ROOT) no existe o no es un directorio."
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DB_BACKUP_DIR="$BACKUP_ROOT/db"
STORAGE_BACKUP_DIR="$BACKUP_ROOT/storage"
DB_DUMP_FILE="$DB_BACKUP_DIR/maildte_${TIMESTAMP}.sql.gz"

mkdir -p "$DB_BACKUP_DIR" "$STORAGE_BACKUP_DIR"

log "Iniciando respaldo de base de datos (contenedor: $POSTGRES_CONTAINER)..."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges \
  | gzip -9 > "$DB_DUMP_FILE"
log "Dump de BD listo: $DB_DUMP_FILE ($(du -h "$DB_DUMP_FILE" | cut -f1))"

log "Sincronizando storage (rsync incremental, sin --delete: los DTE nunca se borran del origen)..."
rsync -a "$STORAGE_ROOT"/ "$STORAGE_BACKUP_DIR"/
log "Storage sincronizado ($(du -sh "$STORAGE_BACKUP_DIR" | cut -f1) totales en el respaldo)."

log "Aplicando retención de ${RETENTION_DAYS} días a dumps de BD..."
find "$DB_BACKUP_DIR" -name 'maildte_*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete

log "Respaldo completo."
