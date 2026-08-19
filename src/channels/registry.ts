import { MaxDriver } from '../max/driver.js'
import { TelegramDriver } from '../telegram/driver.js'
import { WaSession } from '../wa/session.js'
import { CAPABILITIES } from './types.js'
import type { ChannelDriver, ChannelKind } from './types.js'

/**
 * Здесь и только здесь система знает, какой мессенджер каким кодом
 * обслуживается. Добавление нового канала — это новый драйвер и одна
 * строка в этой таблице.
 */
export interface DriverOptions {
  /** Облачный пароль Телеграма, если он включён. Только на время входа. */
  password?: string
}

export function createDriver(
  kind: ChannelKind,
  channelId: string,
  label: string,
  options?: DriverOptions,
): ChannelDriver {
  switch (kind) {
    case 'whatsapp':
      return new WaSession(channelId, label) as unknown as ChannelDriver
    case 'telegram':
      return new TelegramDriver(channelId, label, options) as unknown as ChannelDriver
    case 'max':
      return new MaxDriver(channelId, label) as unknown as ChannelDriver
    default: {
      const never: never = kind
      throw new Error(`Неизвестный тип канала: ${String(never)}`)
    }
  }
}

export function isKnownKind(value: string): value is ChannelKind {
  return value in CAPABILITIES
}
