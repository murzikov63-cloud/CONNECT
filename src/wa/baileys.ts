/**
 * Единственная точка импорта Baileys.
 *
 * Пакет 6.7.x собран как CommonJS и кладёт фабрику сокета в `exports.default`.
 * Наш проект — ESM, а Node в связке ESM→CJS отдаёт под `default` весь объект
 * экспортов, а не саму функцию. Поэтому берём модуль через createRequire и
 * разворачиваем `default` вручную — это работает независимо от того, как
 * пакет собран в конкретной версии.
 *
 * Типы импортируем обычным `import type` — он стирается при компиляции.
 */
import { createRequire } from 'node:module'
import type {
  AuthenticationCreds,
  AuthenticationState,
  ConnectionState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('@whiskeysockets/baileys') as any

type MakeWASocket = (opts: Record<string, unknown>) => WASocket

export const makeWASocket: MakeWASocket = mod.default ?? mod.makeWASocket
export const initAuthCreds: () => AuthenticationCreds = mod.initAuthCreds
export const fetchLatestBaileysVersion: () => Promise<{
  version: [number, number, number]
  isLatest: boolean
}> = mod.fetchLatestBaileysVersion
export const makeCacheableSignalKeyStore = mod.makeCacheableSignalKeyStore as (
  keys: AuthenticationState['keys'],
  logger: unknown,
) => AuthenticationState['keys']
export const downloadMediaMessage = mod.downloadMediaMessage as (
  msg: WAMessage,
  type: 'buffer',
  opts: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Buffer>
export const DisconnectReason = mod.DisconnectReason as Record<string, number>
export const BufferJSON = mod.BufferJSON as {
  replacer: (k: string, v: unknown) => unknown
  reviver: (k: string, v: unknown) => unknown
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const proto = mod.proto as any
export const jidNormalizedUser = mod.jidNormalizedUser as (jid: string) => string
export const isJidGroup = mod.isJidGroup as (jid: string) => boolean
export const isJidBroadcast = mod.isJidBroadcast as (jid: string) => boolean

export type { AuthenticationCreds, AuthenticationState, ConnectionState, WAMessage, WASocket }

if (typeof makeWASocket !== 'function') {
  throw new Error(
    'Не удалось получить фабрику сокета из @whiskeysockets/baileys — ' +
      'скорее всего сменился формат сборки пакета, проверьте версию',
  )
}
