/**
 * Разовое подключение нашего канала чатов к аккаунту amoCRM.
 *
 *     npx tsx scripts/connect-channel.ts
 *
 * Печатает scope_id — его надо положить в .env как AMO_CHAT_SCOPE_ID.
 * Повторный запуск безопасен: amoCRM вернёт тот же scope_id.
 */
import { config } from '../src/config/index.js'
import { connectChannel } from '../src/amo/chat-client.js'

/* eslint-disable no-console */

if (config.AMO_AMOJO_ID === '') {
  console.error('В .env не задан AMO_AMOJO_ID')
  process.exit(1)
}

console.log(`Подключаю канал ${config.AMO_CHAT_CHANNEL_ID} к аккаунту ${config.AMO_AMOJO_ID}…`)

try {
  const result = await connectChannel(config.AMO_AMOJO_ID, 'Messenger')
  console.log('\nГотово.')
  console.log(`  scope_id        : ${result.scope_id}`)
  console.log(`  название канала : ${result.title}`)
  console.log(`  версия хуков    : ${result.hook_api_version}`)
  console.log(`\nПоложите в .env:  AMO_CHAT_SCOPE_ID=${result.scope_id}`)
} catch (err) {
  console.error(`\nНе получилось: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
