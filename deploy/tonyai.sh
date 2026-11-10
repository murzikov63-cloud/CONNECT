#!/usr/bin/env bash
# Сервис на TONYAI.
#
#   deploy/tonyai.sh up          — проверить код, собрать и поднять (это и есть выкладка)
#   deploy/tonyai.sh front ~/messenger-admin — собрать и выложить админку
#   deploy/tonyai.sh ps          — что запущено
#   deploy/tonyai.sh logs app    — журнал (любая команда docker compose)
#
# Наружу сервис выходит через Cloudflare Tunnel (cloudflared-n8n),
# туннель ведёт connect.indolight.com на 127.0.0.1:3400.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"

compose() {
  docker compose --project-directory "$DIR" \
    -f "$DIR/docker-compose.yml" -f "$DIR/docker-compose.tonyai.yml" "$@"
}

if [ "${1:-}" = "front" ]; then
  APP="${2:?укажите папку с фронтом, обычно ~/messenger-admin}"
  echo "== собираю админку"
  (cd "$APP" && npm ci && NITRO_PRESET=node-server npm run build)
  [ -f "$APP/.output/server/index.mjs" ] || { echo "не нашёл собранный сервер в $APP/.output" >&2; exit 1; }
  # Подмена одним движением: никто не увидит полураспакованную папку.
  rm -rf "$DIR/admin-dist.new" "$DIR/admin-dist.old"
  cp -a "$APP/.output" "$DIR/admin-dist.new"
  mv "$DIR/admin-dist" "$DIR/admin-dist.old" 2>/dev/null || true
  mv "$DIR/admin-dist.new" "$DIR/admin-dist"
  rm -rf "$DIR/admin-dist.old"
  compose up -d admin >/dev/null && compose restart admin caddy >/dev/null
  echo "== готово: https://connect.indolight.com"
  exit 0
fi

# Выкладка — только голое «up». С любыми уточнениями («up -d postgres»)
# это обычная команда docker compose: иначе просьба поднять одну базу
# поднимала весь сервис, в том числе на пустой базе.
if [ "${1:-}" != "up" ] || [ "$#" -ne 1 ]; then
  compose "$@"
  exit $?
fi

echo "== проверяю код перед выкладкой"
npm --prefix "$DIR" run check

echo "== собираю"
if ! compose build app max-bridge; then
  echo "СБОРКА НЕ УДАЛАСЬ — работающая версия не тронута" >&2
  exit 1
fi

echo "== поднимаю"
compose up -d

echo "== жду, пока ответит"
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3400/health || true)" = "200" ]; then
    echo "== сервис отвечает"
    exit 0
  fi
  sleep 2
done

echo "СЕРВИС НЕ ПОДНЯЛСЯ за отведённое время" >&2
compose logs app --tail 30 >&2
exit 1
