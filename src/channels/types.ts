import type { EventEmitter } from 'node:events'
import type { OutboundMessage } from '../types.js'

/** Какие мессенджеры умеет платформа. */
export type ChannelKind = 'whatsapp' | 'telegram' | 'max'

export const CHANNEL_TITLES: Record<ChannelKind, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Телеграм',
  max: 'MAX',
}

/**
 * Как подключается канал. От этого зависит, что показывать в админке:
 * QR-код, поле для токена или ссылку на авторизацию.
 */
export type ConnectMethod = 'qr' | 'token' | 'none'

export interface ChannelCapabilities {
  connect: ConnectMethod
  /** Можно ли писать первым тому, кто никогда не писал нам. */
  canInitiate: boolean
  /** Есть ли риск блокировки аккаунта — от этого зависят задержки и лимиты. */
  banRisk: boolean
  media: boolean
  voice: boolean
  quotes: boolean
  deliveryStatus: boolean
}

/**
 * Драйвер мессенджера. Всё, что знает про конкретный мессенджер, живёт
 * внутри драйвера; остальная система работает только с этим интерфейсом
 * и единым внутренним форматом сообщений.
 */
export interface ChannelDriver extends EventEmitter {
  readonly kind: ChannelKind
  readonly channelId: string
  readonly capabilities: ChannelCapabilities

  start(): Promise<void>
  stop(): void
  /** Отвязать аккаунт на стороне мессенджера, а не просто выключить. */
  disconnect(): Promise<void>

  /** Возвращает идентификатор отправленного сообщения в мессенджере. */
  send(out: OutboundMessage): Promise<string>

  /** Готов ли принимать отправку прямо сейчас. */
  isReady(): boolean

  /** Аватар собеседника, если мессенджер его отдаёт. */
  fetchAvatar?(externalChatId: string): Promise<string | null>
}

/**
 * События драйвера (через EventEmitter):
 *   status   (status: ChannelStatus, extra: { reason?, phone? })
 *   qr       (dataUrl: string)
 *   inbound  (msg: InboundMessage)
 *   delivery ({ externalMessageId, status })
 */

export const CAPABILITIES: Record<ChannelKind, ChannelCapabilities> = {
  whatsapp: {
    connect: 'qr',
    canInitiate: true,
    banRisk: true,
    media: true,
    voice: true,
    quotes: true,
    deliveryStatus: true,
  },
  telegram: {
    connect: 'token',
    // Подключаемся как обычный клиент, поэтому ограничений на первое
    // сообщение нет — в отличие от официальных ботов.
    canInitiate: true,
    banRisk: false,
    media: true,
    voice: true,
    quotes: true,
    // О прочтении Телеграм сообщает, о доставке отдельного события нет.
    deliveryStatus: true,
  },
  max: {
    connect: 'token',
    canInitiate: false,
    banRisk: false,
    media: true,
    voice: true,
    quotes: true,
    deliveryStatus: false,
  },
}
