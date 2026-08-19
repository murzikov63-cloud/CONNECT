#!/usr/bin/env bash
# Собирает админку и заливает её на наш сервер.
#
#   deploy/deploy-frontend.sh ~/messenger-admin      # из локальной папки
#   deploy/deploy-frontend.sh https://github.com/…   # прямо из репозитория
#
# Сборка идёт здесь, а не на сервере: у дроплета одно ядро, и незачем
# занимать его сборкой фронта, пока он обслуживает переписку.
set -euo pipefail

SRC="${1:?укажите путь к папке с фронтом или адрес репозитория}"
SERVER="${SERVER:-root@164.92.173.81}"
KEY="${KEY:-$HOME/.ssh/messenger-connect}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [[ "$SRC" == http*://* ]]; then
  echo "== клонирую $SRC"
  git clone --depth 1 "$SRC" "$WORK/src"
  APP="$WORK/src"
else
  APP="$SRC"
fi

echo "== собираю"
cd "$APP"
npm ci
# Пресет node: по умолчанию Lovable собирает под Cloudflare Workers,
# а нам нужен обычный процесс Node рядом с API.
NITRO_PRESET=node-server npm run build

DIST=".output"
[ -f "$DIST/server/index.mjs" ] || { echo "не нашёл собранный сервер в $DIST"; exit 1; }

echo "== заливаю на $SERVER"
tar czf - -C "$DIST" . | ssh -i "$KEY" -o StrictHostKeyChecking=no "$SERVER" '
  set -e
  rm -rf /opt/messenger-connect/admin-dist.new
  mkdir -p /opt/messenger-connect/admin-dist.new
  tar xzf - -C /opt/messenger-connect/admin-dist.new
  # Подмена одним движением: пользователь не увидит полураспакованную папку.
  rm -rf /opt/messenger-connect/admin-dist.old
  mv /opt/messenger-connect/admin-dist /opt/messenger-connect/admin-dist.old 2>/dev/null || true
  mv /opt/messenger-connect/admin-dist.new /opt/messenger-connect/admin-dist
  rm -rf /opt/messenger-connect/admin-dist.old
  cd /opt/messenger-connect && docker compose up -d admin >/dev/null && docker compose restart admin caddy >/dev/null
'
echo "== готово: https://connect.indolight.com"
