# connect.indolight.com — DNS и сертификат

Сервер: Франкфурт. Caddy сам получает сертификат Let's Encrypt по HTTP-01,
для этого 80 и 443 порты должны приходить прямо на сервер.

## Важно про Cloudflare

Остальные поддомены indolight.com (n8n, board, parser) ходят через
Cloudflare Tunnel. Здесь так делать **не надо** — amoCRM должен стучаться
напрямую, а Tunnel добавляет лишнюю точку отказа на боевой переписке.

Поэтому в Cloudflare DNS для `connect`:

- Тип `A`, значение — IP франкфуртского сервера
- **Proxy status: DNS only (серое облако)**, иначе HTTP-01 не пройдёт
- Cloudflare Access на этот поддомен **не вешать** — он сломает вебхуки amoCRM

Админку наружу не публикуем: фронт живёт на домене Lovable и ходит в
`/api/*` с ключом. Публично доступны только `/amojo/*`, `/amocrm/*`, `/media/*`.

Это отличается от того, как сделаны n8n и board, — там Access уместен,
здесь нет.

## Проверка после поднятия

    curl -I https://connect.indolight.com/api/health
