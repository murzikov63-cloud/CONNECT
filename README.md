# Messenger — мост WhatsApp ⇄ amoCRM

Свой сервис вместо подписки Radist.Online. Сообщения WhatsApp с 3–4 рабочих
номеров попадают в карточки amoCRM, менеджеры отвечают из amoCRM как обычно.

- ТЗ: `../TZ-wa-amocrm-bridge.md`
- Публичный адрес: https://connect.indolight.com
- Сервер: **164.92.173.81**, DigitalOcean FRA1, Ubuntu 24.04, 2 ГБ / 50 ГБ NVMe
- Вход только по ключу `~/.ssh/messenger-connect` на TONYAI, пароль отключён
- Аккаунт amoCRM: murzikov63.amocrm.ru (ID 28694251)

> ⚠️ Долгосрочный токен amoCRM годен до **2027-02-28**. Перевыпустить в январе 2027,
> иначе связь с CRM встанет. Секреты — только в `.env` (в git не попадает).

## Состояние

| Этап | Статус |
|---|---|
| 0. Исследование amoCRM и Baileys | ✅ `docs/amocrm-notes.md`, `docs/wa-notes.md` |
| 0.3 Каркас репозитория | ✅ |
| 1. Доступы | ✅ интеграция и канал чатов получены 2026-08-18 |
| 2. Ядро WhatsApp | ✅ типы, линт, тесты и живые проверки зелёные |
| 3. Коннектор amoCRM | 🟡 подпись и подключение канала ✅, дальше сообщения |
| 4. Admin API + фронт | — |
| 5. Деплой | 🟡 сервер готов, стек работает; ждём сертификат Cloudflare |
| 6. Запуск | — |

## Запуск локально

    cp .env.example .env      # заполнить
    docker compose up -d postgres redis
    npm ci && npm run dev

## Проверки

    npm run check                      # типы + линт + тесты (36 тестов)
    npx tsx scripts/check-baileys.ts   # связка с библиотекой WhatsApp
    npx tsx scripts/check-db.ts        # миграции и гарантии схемы на живой базе

`check-baileys` запускать обязательно после каждого обновления Baileys —
он ловит пропавшие экспорты и несовместимость хранения ключей сессии.

`check-db` требует пустую тестовую базу, например:

    docker run -d --rm --name pg-test -e POSTGRES_USER=test \
      -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55433:5432 postgres:16-alpine
    PGHOST=127.0.0.1 PGPORT=55433 PGUSER=test PGPASSWORD=test PGDATABASE=test \
      PUBLIC_DOMAIN=x REDIS_URL=redis://127.0.0.1:6379 ADMIN_API_KEY=test-key \
      npx tsx scripts/check-db.ts

## Обновление Baileys

Версия зафиксирована точно (`6.7.24`, без `^`) — протокол WhatsApp меняется,
и автоматическое обновление ломает связь. Порядок обновления и что проверять —
`docs/wa-notes.md`.
