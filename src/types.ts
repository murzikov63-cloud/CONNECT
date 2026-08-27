/** Единый внутренний формат — им обмениваются модули wa/, amo/ и очереди. */

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'unsupported'

export type ChannelStatus =
  | 'new'
  | 'connecting'
  | 'qr'
  | 'online'
  | 'offline'
  | 'banned'
  | 'logged_out'

export interface MediaPayload {
  path: string
  mime: string
  name: string
  size: number
  /** Длительность в секундах — для голосовых и видео. */
  durationSec?: number
}

export interface InboundMessage {
  /**
   * Внутренний номер WhatsApp («…@lid»), если сообщение пришло по нему.
   * Нужен, чтобы узнать переписку в своих же сообщениях: в них WhatsApp
   * телефона не даёт вовсе.
   */
  altChatId?: string
  channelId: string
  externalMessageId: string
  externalChatId: string
  /** Телефон в формате 79991234567 (без +), пусто для групп. */
  phone: string
  isGroup: boolean
  /** true — сообщение отправлено с самого телефона, а не клиентом. */
  fromMe: boolean
  pushName: string
  type: MessageType
  body: string
  media?: MediaPayload
  location?: { lat: number; lng: number; name?: string }
  contact?: { name: string; phone: string }
  quotedExternalMessageId?: string
  occurredAt: Date
}

export interface OutboundMessage {
  channelId: string
  externalChatId: string
  /**
   * Телефон получателя, если известен. Нужен для первого сообщения
   * незнакомому человеку: мессенджер помнит собеседника, только пока
   * не перезапустился, а по телефону его всегда можно найти заново.
   */
  phone?: string
  type: MessageType
  body: string
  /** Локальный путь к уже скачанному файлу либо http(s)-ссылка из amoCRM. */
  mediaPath?: string
  mediaMime?: string
  mediaName?: string
  quotedExternalMessageId?: string
  /** ID сообщения в amoCRM — по нему отдаём статус доставки обратно. */
  amoMessageId?: string
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface DeliveryUpdate {
  channelId: string
  externalMessageId: string
  status: DeliveryStatus
  error?: string
  at: Date
}
