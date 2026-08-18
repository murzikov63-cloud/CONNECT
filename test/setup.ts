// Минимальное окружение, чтобы модуль конфига прошёл валидацию в тестах.
process.env['PUBLIC_DOMAIN'] ??= 'connect.example.com'
process.env['PGHOST'] ??= 'localhost'
process.env['PGUSER'] ??= 'test'
process.env['PGPASSWORD'] ??= 'test'
process.env['PGDATABASE'] ??= 'test'
process.env['REDIS_URL'] ??= 'redis://localhost:6379'
process.env['ADMIN_API_KEY'] ??= 'test-admin-key'
process.env['MEDIA_DIR'] ??= '/tmp/messenger-test-media'
