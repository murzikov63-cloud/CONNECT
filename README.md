# Messenger — мост WhatsApp ⇄ amoCRM

Свой сервис вместо подписки Radist.Online. Сообщения WhatsApp с 3–4 рабочих
номеров попадают в карточки amoCRM, менеджеры отвечают из amoCRM как обычно.

- ТЗ: `../TZ-wa-amocrm-bridge.md`
- Публичный адрес: https://connect.indolight.com
- Сервер: Франкфурт

## Состояние

| Этап | Статус |
|---|---|
| 0. Исследование amoCRM и Baileys | ✅ `docs/amocrm-notes.md`, `docs/wa-notes.md` |
| 0.3 Каркас репозитория | ✅ |
| 1. Доступы (Анатолий) | ⏳ `docs/anatoly/` |
| 2. Ядро WhatsApp | — |
| 3. Коннектор amoCRM | — |
| 4. Admin API + фронт | — |
| 5. Деплой | — |
| 6. Запуск | — |

## Запуск локально

    cp .env.example .env      # заполнить
    docker compose up -d postgres redis
    npm ci && npm run dev

## Проверки перед коммитом

    npm run check             # типы + линт + тесты

## Обновление Baileys

Версия зафиксирована точно (`6.7.24`, без `^`) — протокол WhatsApp меняется,
и автоматическое обновление ломает связь. Порядок обновления и что проверять —
`docs/wa-notes.md`.
