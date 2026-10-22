#!/usr/bin/env bash
# Chili POS database backup (cron-friendly). Requires MongoDB Database Tools (mongodump).
#   MONGODB_URI=... BACKUP_DIR=/var/backups/chili-pos ./scripts/backup.sh
# Optional: BACKUP_RETENTION_DAYS (default 14), BACKUP_OPLOG=1 (whole-server, point-in-time), BACKUP_GPG_RECIPIENT (encrypt archives with gpg),
#           BACKUP_STATUS_FILE (default $BACKUP_DIR/last-backup.json — shown in Settings → Business).
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chili-pos}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
STATUS_FILE="${BACKUP_STATUS_FILE:-$BACKUP_DIR/last-backup.json}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/chili-pos-$STAMP.archive.gz"

write_status() {
  printf '{"at":"%s","ok":%s,"file":"%s","sizeBytes":%s,"error":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${3:-0}" "${4:-null}" > "$STATUS_FILE"
}
trap 'write_status false "" 0 "\"mongodump failed (exit $?)\""' ERR

# BACKUP_OPLOG=1 adds --oplog for a point-in-time consistent dump; it requires a URI without a database name
# (whole replica set). Per-database dumps (the default) are consistent per collection.
EXTRA=()
if [[ "${BACKUP_OPLOG:-0}" == "1" ]]; then EXTRA+=(--oplog); fi
mongodump --uri="$MONGODB_URI" --archive="$FILE" --gzip "${EXTRA[@]}" 2> >(grep -v 'writing\|done dumping' >&2)
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE.gpg" "$FILE"
  rm -f "$FILE"
  FILE="$FILE.gpg"
fi
chmod 600 "$FILE"
SIZE="$(stat -c %s "$FILE")"
find "$BACKUP_DIR" -name 'chili-pos-*.archive.gz*' -mtime +"$RETENTION" -delete
write_status true "$FILE" "$SIZE"
echo "Backup written: $FILE ($SIZE bytes)"
