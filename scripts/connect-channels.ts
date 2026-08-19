/**
 * Подключает все настроенные каналы чатов к аккаунту amoCRM.
 *
 *   npx tsx scripts/connect-channels.ts
 *
 * Печатает scope_id по каждому — их надо положить в .env.
 * Повторный запуск безопасен: amoCRM вернёт те же значения.
 */
import { amoChannels } from '../src/amo/channels.js'
import { connectChannel } from '../src/amo/chat-client.js'
import { CHANNEL_TITLES } from '../src/channels/types.js'
import { config } from '../src/config/index.js'

/* eslint-disable no-console */

const TITLES: Record<string, string> = {
  whatsapp: 'WA CONNECT',
  telegram: 'TG CONNECT',
  max: 'MAX CONNECT',
}
const ENV_KEYS: Record<string, string> = {
  whatsapp: 'AMO_WA_SCOPE_ID',
  telegram: 'AMO_TG_SCOPE_ID',
  max: 'AMO_MAX_SCOPE_ID',
}

if (config.AMO_AMOJO_ID === '') {
  console.error('В .env не задан AMO_AMOJO_ID')
  process.exit(1)
}

let failed = 0
for (const channel of amoChannels()) {
  const title = TITLES[channel.kind] ?? CHANNEL_TITLES[channel.kind]
  if (channel.channelId === '' || channel.secretKey === '') {
    console.log(`  ${title}: ключи не заданы, пропускаю`)
    continue
  }
  try {
    const result = await connectChannel(channel, config.AMO_AMOJO_ID, title)
    console.log(`  ${title}: подключён`)
    console.log(`    ${ENV_KEYS[channel.kind]}=${result.scope_id}`)
  } catch (err) {
    failed++
    console.error(`  ${title}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
