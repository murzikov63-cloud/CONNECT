#!/usr/bin/env bash
# Выкладка сервиса на сервер.
#
# Почему не просто «скопировать файлы»: копирование добавляет и заменяет,
# но не удаляет. Если файл переехал в другую папку, на сервере остаются оба,
# и сборка падает на старом. Поэтому исходники переносятся с полной заменой.
#
# И главное: если сборка не удалась — выходим с ошибкой, а не оставляем
# молча работать старую версию.
set -euo pipefail

SERVER="${SERVER:-root@164.92.173.81}"
KEY="${KEY:-$HOME/.ssh/messenger-connect}"
REMOTE="/opt/messenger-connect"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER")

cd "$(dirname "$0")/.."

echo "== проверяю локально перед выкладкой"
npm run check

echo "== переношу код (с удалением исчезнувших файлов)"
"${SSH[@]}" "rm -rf $REMOTE/src $REMOTE/scripts $REMOTE/test $REMOTE/deploy"
tar czf - --exclude=node_modules --exclude=dist --exclude=.git \
          --exclude=.env --exclude=caddy/origin --exclude=admin-dist . \
  | "${SSH[@]}" "tar xzf - -C $REMOTE"

echo "== собираю образ"
if ! "${SSH[@]}" "cd $REMOTE && docker compose build app"; then
  echo "СБОРКА НЕ УДАЛАСЬ — на сервере продолжает работать прежняя версия" >&2
  exit 1
fi

echo "== перезапускаю сервис"
"${SSH[@]}" "cd $REMOTE && docker compose up -d --force-recreate app"

echo "== жду, пока поднимется"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://connect.indolight.com/health || true)
  if [ "$code" = "200" ]; then
    echo "== сервис отвечает"
    "${SSH[@]}" "cd $REMOTE && docker compose logs app --tail 5 | grep -i миграц || true"
    exit 0
  fi
done

echo "СЕРВИС НЕ ПОДНЯЛСЯ за отведённое время" >&2
"${SSH[@]}" "cd $REMOTE && docker compose logs app --tail 30" >&2
exit 1
