#!/usr/bin/env bash
# Сторож памяти и диска. Никакой модели — простая проверка по таймеру,
# как принято в отделе аварий: механические проверки не через LLM.
#
# Ставится systemd-таймером, см. deploy/resource-watch.timer
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/messenger-connect/.env}"
STAMP_DIR="${STAMP_DIR:-/var/lib/messenger-connect}"
MEM_LIMIT_PCT="${MEM_LIMIT_PCT:-80}"
DISK_LIMIT_PCT="${DISK_LIMIT_PCT:-80}"
SWAP_LIMIT_PCT="${SWAP_LIMIT_PCT:-50}"
COOLDOWN_SEC="${COOLDOWN_SEC:-3600}"

mkdir -p "$STAMP_DIR"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

notify() {
  local key="$1" text="$2" stamp="$STAMP_DIR/$1.stamp" now
  now=$(date +%s)
  # Одинаковая жалоба не чаще раза в час, иначе за ночь придёт сотня сообщений.
  if [ -f "$stamp" ] && [ $(( now - $(cat "$stamp") )) -lt "$COOLDOWN_SEC" ]; then
    return 0
  fi
  echo "$now" > "$stamp"
  logger -t messenger-watch "$text"
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_ALERT_CHAT_ID:-}" ]; then
    curl -s --max-time 15 -o /dev/null \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_ALERT_CHAT_ID}" \
      --data-urlencode "text=${text}" || true
  fi
}

clear_stamp() { rm -f "$STAMP_DIR/$1.stamp"; }

# --- память ---
read -r total used <<<"$(free -m | awk '/^Mem:/{print $2, $3}')"
mem_pct=$(( used * 100 / total ))
if [ "$mem_pct" -ge "$MEM_LIMIT_PCT" ]; then
  notify memory "⚠️ Messenger: память ${mem_pct}% (${used} из ${total} МБ). Сервис близок к перезапуску по нехватке памяти."
else
  clear_stamp memory
fi

# --- подкачка ---
read -r stotal sused <<<"$(free -m | awk '/^Swap:/{print $2, $3}')"
if [ "${stotal:-0}" -gt 0 ]; then
  swap_pct=$(( sused * 100 / stotal ))
  if [ "$swap_pct" -ge "$SWAP_LIMIT_PCT" ]; then
    notify swap "⚠️ Messenger: подкачка занята на ${swap_pct}%. Памяти не хватает уже постоянно — пора увеличивать сервер."
  else
    clear_stamp swap
  fi
fi

# --- диск ---
disk_pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$disk_pct" -ge "$DISK_LIMIT_PCT" ]; then
  free_h=$(df -h --output=avail / | tail -1 | tr -d ' ')
  notify disk "⚠️ Messenger: диск занят на ${disk_pct}%, свободно ${free_h}. Скоро перестанут сохраняться вложения."
else
  clear_stamp disk
fi

# --- контейнеры, которых не должно не быть ---
# Список берём из самого docker-compose, а не хардкодом: иначе после
# добавления или переименования сервиса сторож молча перестанет его видеть.
PROJECT_DIR="${PROJECT_DIR:-/opt/messenger-connect}"
if command -v docker >/dev/null 2>&1 && [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
  running=$(cd "$PROJECT_DIR" && docker compose ps --services --status running 2>/dev/null || true)
  expected=$(cd "$PROJECT_DIR" && docker compose config --services 2>/dev/null || true)
  for svc in $expected; do
    if ! echo "$running" | grep -qx "$svc"; then
      notify "down-$svc" "🔴 Messenger: контейнер $svc не работает."
    else
      clear_stamp "down-$svc"
    fi
  done
fi
