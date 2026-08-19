import { TelegramDriver } from '../telegram/driver.js'
import { WaSession } from '../wa/session.js'
import { CAPABILITIES, CHANNEL_TITLES } from './types.js'
import type { ChannelDriver, ChannelKind } from './types.js'

/**
 * Здесь и только здесь система знает, какой мессенджер каким кодом
 * обслуживается. Добавление нового канала — это новый драйвер и одна
 * строка в этой таблице.
 */
export function createDriver(kind: ChannelKind, channelId: string, label: string): ChannelDriver {
  switch (kind) {
    case 'whatsapp':
      return new WaSession(channelId, label) as unknown as ChannelDriver
    case 'telegram':
      return new TelegramDriver(channelId, label) as unknown as ChannelDriver
    case 'max':
      throw new Error(`Канал «${CHANNEL_TITLES[kind]}» ещё не подключён к платформе`)
    default: {
      const never: never = kind
      throw new Error(`Неизвестный тип канала: ${String(never)}`)
    }
  }
}

export function isKnownKind(value: string): value is ChannelKind {
  return value in CAPABILITIES
}
