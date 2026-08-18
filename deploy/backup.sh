#!/usr/bin/env bash
# Ежедневный дамп базы. В ней же лежат ключи сессий WhatsApp,
# поэтому отдельный бэкап auth-state не нужен — он внутри.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/messenger-connect}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/messenger-connect}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$PROJECT_DIR"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y-%m-%d_%H%M)
file="$BACKUP_DIR/db_$stamp.sql.gz"

# Дамп снимаем изнутри контейнера: наружу порт базы не опубликован.
if docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDATABASE" \
     --no-owner --no-privileges | gzip -9 > "$file.tmp"; then
  mv "$file.tmp" "$file"
else
  rm -f "$file.tmp"
  echo "дамп не удался" >&2
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_ALERT_CHAT_ID:-}" ]; then
    curl -s --max-time 15 -o /dev/null \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_ALERT_CHAT_ID}" \
      --data-urlencode "text=🔴 Messenger: не удалось сделать бэкап базы." || true
  fi
  exit 1
fi

size=$(stat -c %s "$file")
# Пустой дамп — это тоже авария, просто тихая.
if [ "$size" -lt 1000 ]; then
  echo "дамп подозрительно мал: $size байт" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'db_*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "готово: $file ($(numfmt --to=iec "$size"))"
