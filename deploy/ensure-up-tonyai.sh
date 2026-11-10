#!/usr/bin/env bash
# Сторож сервиса на TONYAI. Запускается таймером messenger-ensure-up
# каждые 5 минут.
#
# Что делает:
#   1. Ждёт Docker: после перезапуска WSL Docker Desktop поднимается не сразу,
#      и автостарт контейнеров может не случиться (та же беда, что у WAHA
#      и OpenClaw).
#   2. Если какой-то контейнер лежит — поднимает сервис сам и пишет об этом
#      в тот же Телеграм, куда идут остальные тревоги Messenger.
#   3. Если сервис жив, но мессенджер отвалился (номер разлогинился и т. п.)
#      дольше двух проверок подряд — сообщает: тут нужен человек.
#
# Об одной беде пишет один раз, и ещё раз — когда она прошла. Состояние
# между запусками держит в state/ensure-up (не в git).
set -uo pipefail

DIR="/home/claudeuser/messenger-connect"
STATE="$DIR/state/ensure-up"
SERVICES="postgres redis app max-bridge admin caddy"
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a

send() {
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_ALERT_CHAT_ID:-}" ]; then
    curl -s --max-time 15 -o /dev/null \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_ALERT_CHAT_ID}" \
      --data-urlencode "text=$1" || true
  fi
}

# Беда началась: пишем, только если о ней ещё не писали.
raise() {  # ключ текст
  [ -f "$STATE/$1" ] && return 0
  touch "$STATE/$1"
  log "$2"; send "$2"
}

# Беда прошла: пишем, только если о ней писали.
clear_() {  # ключ текст
  [ -f "$STATE/$1" ] || return 0
  rm -f "$STATE/$1"
  log "$2"; send "$2"
}

# --- 1. Docker ---
for i in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { raise docker "🔴 Messenger на TONYAI: Docker не поднялся за 5 минут, сервис не работает."; exit 1; }
  sleep 5
done
clear_ docker "🟢 Messenger на TONYAI: Docker снова работает."

# --- 2. Контейнеры ---
down=""
for svc in $SERVICES; do
  running=$(docker inspect -f '{{.State.Running}}' "messenger-connect-$svc-1" 2>/dev/null || echo missing)
  [ "$running" = "true" ] || down="$down $svc"
done

if [ -n "$down" ]; then
  log "лежат:$down — поднимаю"
  # Именно «up -d», а не голое «up»: голое — это выкладка со сборкой.
  "$DIR/deploy/tonyai.sh" up -d >/dev/null 2>&1
  ok=""
  for _ in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3400/health || true)" = "200" ]; then
      ok=1; break
    fi
    sleep 4
  done
  if [ -n "$ok" ]; then
    rm -f "$STATE/down"
    log "поднял"
    send "🟡 Messenger на TONYAI: лежало —$down. Поднял сам, сервис отвечает."
  else
    raise down "🔴 Messenger на TONYAI: лежало —$down. Поднять не получилось, нужен человек."
  fi
  exit 0
fi
clear_ down "🟢 Messenger на TONYAI: сервис снова работает."

# --- 3. Сервис отвечает? ---
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3400/health || true)
if [ "$code" != "200" ]; then
  # Контейнеры живы, а ответа нет — после двух проверок подряд перезапускаем app.
  if [ -f "$STATE/health-1" ]; then
    rm -f "$STATE/health-1"
    log "не отвечает вторую проверку подряд ($code) — перезапускаю app"
    "$DIR/deploy/tonyai.sh" restart app >/dev/null 2>&1
    raise health "🟠 Messenger на TONYAI: сервис не отвечал 10 минут, перезапустил. Если сообщение повторится — нужен человек."
  else
    touch "$STATE/health-1"
  fi
  exit 0
fi
rm -f "$STATE/health-1"
clear_ health "🟢 Messenger на TONYAI: сервис снова отвечает."

# --- 4. Мессенджеры в сети? ---
offline=$(curl -s --max-time 15 -H "X-Api-Key: ${ADMIN_API_KEY:-}" http://127.0.0.1:3400/api/daily \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(" ".join(m["мессенджер"] for m in d.get("мессенджеры", []) if not m.get("вСети")))
' 2>/dev/null) || exit 0

for name in WhatsApp Телеграм MAX; do
  key="offline-$name"
  if [[ " $offline " == *" $name "* ]]; then
    # Короткие переподключения случаются — тревожимся со второй проверки подряд.
    if [ -f "$STATE/$key-1" ]; then
      raise "$key" "🔴 Messenger: $name не в сети больше 5 минут. Сообщения клиентов в этом мессенджере сейчас не доходят. Возможно, номер надо подключить заново на connect.indolight.com."
    else
      touch "$STATE/$key-1"
    fi
  else
    rm -f "$STATE/$key-1"
    clear_ "$key" "🟢 Messenger: $name снова в сети."
  fi
done
exit 0
