#!/usr/bin/env bash
# Ночной снимок базы на TONYAI.
#
# В базе лежат ключи подключения номеров: потеряем их — WhatsApp, Телеграм
# придётся подключать заново, сканируя коды с телефонов. Общий ночной бэкап
# проектов (projects-backup, 04:30) забирает домашнюю папку, но в тома
# Docker не заглядывает. Поэтому за полчаса до него кладём снимок базы
# и сессию MAX в backups/ проекта — дальше их увозит общий бэкап
# на диск Windows и в Google Drive.
#
# Вложения клиентов (media) не копируем — как и на прежнем сервере:
# это 300+ МБ, и amoCRM хранит свои копии.
set -euo pipefail

DIR="/home/claudeuser/messenger-connect"
OUT="$DIR/backups/nightly"
KEEP_DAYS=14

mkdir -p "$OUT"
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a

сообщить() {
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_ALERT_CHAT_ID:-}" ]; then
    curl -s --max-time 15 -o /dev/null \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_ALERT_CHAT_ID}" \
      --data-urlencode "text=$1" || true
  fi
}

stamp=$(date -u +%Y-%m-%d_%H%M)
file="$OUT/db_$stamp.sql.gz"

if ! docker exec messenger-connect-postgres-1 \
     pg_dump -U "$PGUSER" -d "$PGDATABASE" --no-owner --no-privileges | gzip -9 > "$file.tmp"; then
  rm -f "$file.tmp"
  сообщить "🔴 Messenger на TONYAI: не удалось сделать снимок базы."
  exit 1
fi
mv "$file.tmp" "$file"

# Пустой снимок — тоже авария, просто тихая.
size=$(stat -c %s "$file")
if [ "$size" -lt 1000 ]; then
  сообщить "🔴 Messenger на TONYAI: снимок базы подозрительно мал ($size байт)."
  exit 1
fi

# Сессия MAX живёт файлом в отдельном томе — без неё MAX тоже придётся
# подключать заново. Она крошечная, держим только последнюю.
docker run --rm -v messenger-connect_maxsessions:/data:ro -v "$OUT":/out alpine \
  sh -c "tar czf /out/maxsessions_latest.tgz -C /data . && chown $(id -u):$(id -g) /out/maxsessions_latest.tgz" \
  || сообщить "⚠️ Messenger на TONYAI: сессия MAX не скопировалась."

find "$OUT" -name 'db_*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "готово: $file ($(numfmt --to=iec "$size"))"
