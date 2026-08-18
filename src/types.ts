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

export type NumberStatus =
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
  numberId: string
  waMessageId: string
  chatJid: string
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
  quotedWaMessageId?: string
  occurredAt: Date
}

export interface OutboundMessage {
  numberId: string
  chatJid: string
  type: MessageType
  body: string
  /** Локальный путь к уже скачанному файлу либо http(s)-ссылка из amoCRM. */
  mediaPath?: string
  mediaMime?: string
  mediaName?: string
  quotedWaMessageId?: string
  /** ID сообщения в amoCRM — по нему отдаём статус доставки обратно. */
  amoMessageId?: string
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface DeliveryUpdate {
  numberId: string
  waMessageId: string
  status: DeliveryStatus
  error?: string
  at: Date
}
