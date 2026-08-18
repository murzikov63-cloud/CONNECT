/**
 * Проверка связки с Baileys. Запускать после каждого обновления библиотеки:
 *
 *     npx tsx scripts/check-baileys.ts
 *
 * Ловит ровно то, что ломается при смене мажорной версии: пропавшие экспорты,
 * смену формата сборки пакета и несовместимость сериализации ключей сессии.
 */
import {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
} from '../src/wa/baileys.js'

/* eslint-disable no-console */

let failed = 0

function check(name: string, ok: boolean, extra = ''): void {
  if (!ok) failed++
  console.log(`${ok ? '  OK ' : 'СБОЙ '} ${name}${extra === '' ? '' : ` — ${extra}`}`)
}

const fns: [string, unknown][] = [
  ['makeWASocket', makeWASocket],
  ['initAuthCreds', initAuthCreds],
  ['fetchLatestBaileysVersion', fetchLatestBaileysVersion],
  ['makeCacheableSignalKeyStore', makeCacheableSignalKeyStore],
  ['downloadMediaMessage', downloadMediaMessage],
  ['jidNormalizedUser', jidNormalizedUser],
  ['isJidGroup', isJidGroup],
]
for (const [name, value] of fns) check(name, typeof value === 'function')

check(
  'DisconnectReason.loggedOut',
  typeof DisconnectReason['loggedOut'] === 'number',
  String(DisconnectReason['loggedOut']),
)
check('BufferJSON.replacer', typeof BufferJSON.replacer === 'function')
check(
  'proto.Message.AppStateSyncKeyData.fromObject',
  typeof proto?.Message?.AppStateSyncKeyData?.fromObject === 'function',
)

// Ключи сессии лежат в Postgres как jsonb — Buffer'ы обязаны пережить путь туда и обратно.
const creds = initAuthCreds()
const stored = JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) as unknown
const restored = JSON.parse(JSON.stringify(stored), BufferJSON.reviver) as {
  noiseKey: { private: unknown }
}
check('ключи сессии переживают сохранение в базу и обратно', Buffer.isBuffer(restored.noiseKey.private))

const { version, isLatest } = await fetchLatestBaileysVersion()
check('получена версия протокола WhatsApp', version.length === 3, `${version.join('.')}, актуальная: ${isLatest}`)

console.log(failed === 0 ? '\nВсё в порядке.' : `\nПроблем: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
