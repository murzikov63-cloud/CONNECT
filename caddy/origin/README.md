Сюда кладутся два файла Origin Certificate из Cloudflare:

- `cert.pem` — Origin Certificate
- `key.pem`  — Private key

Оба выдаются один раз при создании сертификата в панели Cloudflare
(SSL/TLS → Origin Server → Create Certificate). Приватный ключ показывают
только в этот момент, второй раз его не посмотреть.

В git не попадают — см. .gitignore.
