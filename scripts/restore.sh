#!/usr/bin/env bash
# Restore a Chili POS backup archive into a database. ALWAYS rehearse on a test database first.
#   TARGET_URI=mongodb://127.0.0.1:27017/chili_restore_test?replicaSet=rs0 ./scripts/restore.sh /var/backups/chili-pos/chili-pos-....archive.gz
# Restoring over production requires CONFIRM_PRODUCTION_RESTORE=yes.
set -euo pipefail
ARCHIVE="${1:?usage: restore.sh <archive.gz[.gpg]>}"
: "${TARGET_URI:?TARGET_URI is required}"
SOURCE_DB="${SOURCE_DB:-chili_pos}"
TARGET_DB="$(echo "$TARGET_URI" | sed -E 's#^[a-z+]+://[^/]+/([^?]*).*#\1#')"
if [[ -z "$TARGET_DB" ]]; then echo "TARGET_URI must include a database name" >&2; exit 2; fi
if [[ "$TARGET_DB" == "$SOURCE_DB" && "${CONFIRM_PRODUCTION_RESTORE:-}" != "yes" ]]; then
  echo "Refusing to overwrite '$TARGET_DB'. Set CONFIRM_PRODUCTION_RESTORE=yes if you really mean it." >&2
  exit 3
fi
INPUT="$ARCHIVE"
if [[ "$ARCHIVE" == *.gpg ]]; then
  INPUT="$(mktemp)"
  trap 'rm -f "$INPUT"' EXIT
  gpg --batch --yes --decrypt --output "$INPUT" "$ARCHIVE"
fi
# mongorestore filters by the database in the URI, so connect at server level and map namespaces instead.
SERVER_URI="$(echo "$TARGET_URI" | sed -E 's#^([a-z+]+://[^/]+)/[^?]*#\1/#')"
mongorestore --uri="$SERVER_URI" --archive="$INPUT" --gzip --drop \
  --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*" --quiet
echo "Restored $ARCHIVE into $TARGET_DB"
