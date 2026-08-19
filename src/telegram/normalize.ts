import type { InboundMessage, MessageType } from '../types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Разбор сообщений Телеграма в наш единый формат.
 * Вынесено отдельно от драйвера, чтобы проверяться тестами без сети.
 */

export interface TgContent {
  type: MessageType
  body: string
  mediaMime?: string
  mediaName?: string
  durationSec?: number
  location?: { lat: number; lng: number; name?: string }
  contact?: { name: string; phone: string }
  /** Есть ли что скачивать: у Телеграма это решается по наличию media. */
  hasMedia: boolean
}

function documentAttr(doc: any, className: string): any {
  return (doc?.attributes ?? []).find((a: any) => a?.className === className)
}

/** Определяет тип сообщения по вложению. */
export function extractContent(msg: any): TgContent {
  const text: string = msg?.message ?? ''
  const media = msg?.media

  if (media == null) {
    return { type: 'text', body: text, hasMedia: false }
  }

  // Фото приходит отдельным типом, всё остальное — «документом» с признаками.
  if (media.className === 'MessageMediaPhoto' || msg.photo != null) {
    return { type: 'image', body: text, mediaMime: 'image/jpeg', hasMedia: true }
  }

  if (media.className === 'MessageMediaGeo' || media.className === 'MessageMediaGeoLive') {
    const geo = media.geo ?? {}
    return {
      type: 'location',
      body: text,
      location: { lat: Number(geo.lat ?? 0), lng: Number(geo.long ?? 0) },
      hasMedia: false,
    }
  }

  if (media.className === 'MessageMediaVenue') {
    const geo = media.geo ?? {}
    return {
      type: 'location',
      body: media.title ?? text,
      location: {
        lat: Number(geo.lat ?? 0),
        lng: Number(geo.long ?? 0),
        ...(media.title !== undefined ? { name: String(media.title) } : {}),
      },
      hasMedia: false,
    }
  }

  if (media.className === 'MessageMediaContact') {
    const name = [media.firstName, media.lastName].filter(Boolean).join(' ').trim()
    return {
      type: 'contact',
      body: name,
      contact: { name, phone: String(media.phoneNumber ?? '').replace(/\D/g, '') },
      hasMedia: false,
    }
  }

  if (media.className === 'MessageMediaDocument') {
    const doc = media.document ?? {}
    const mime: string = doc.mimeType ?? 'application/octet-stream'

    if (documentAttr(doc, 'DocumentAttributeSticker') != null) {
      return { type: 'sticker', body: '', mediaMime: mime, hasMedia: true }
    }

    const audio = documentAttr(doc, 'DocumentAttributeAudio')
    if (audio != null) {
      return {
        type: audio.voice === true ? 'voice' : 'audio',
        body: text,
        mediaMime: mime,
        durationSec: Number(audio.duration ?? 0),
        hasMedia: true,
      }
    }

    const video = documentAttr(doc, 'DocumentAttributeVideo')
    if (video != null) {
      return {
        type: 'video',
        body: text,
        mediaMime: mime,
        durationSec: Number(video.duration ?? 0),
        hasMedia: true,
      }
    }

    const filename = documentAttr(doc, 'DocumentAttributeFilename')
    return {
      type: 'document',
      body: text,
      mediaMime: mime,
      mediaName: filename?.fileName ?? 'file',
      hasMedia: true,
    }
  }

  // Опросы, игры, приглашения и прочее, чего мы не показываем в CRM.
  return { type: 'unsupported', body: text, hasMedia: false }
}

/** Сообщения, которые не должны попадать менеджеру. */
export function isIgnorable(msg: any): boolean {
  if (msg == null) return true
  // Служебные: «пользователь присоединился», смена аватара группы и т.п.
  if (msg.action != null) return true
  const empty = (msg.message ?? '') === '' && msg.media == null
  return empty
}

/** Имя собеседника: как показал бы сам Телеграм. */
export function displayName(sender: any): string {
  if (sender == null) return ''
  const parts = [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim()
  if (parts !== '') return parts
  if (sender.username != null) return `@${String(sender.username)}`
  return String(sender.title ?? '')
}

/**
 * Телефон в Телеграме виден далеко не всегда — большинство прячет его
 * настройками приватности. Пустая строка здесь нормальна.
 */
export function senderPhone(sender: any): string {
  return String(sender?.phone ?? '').replace(/\D/g, '')
}

export function normalizeInbound(
  channelId: string,
  msg: any,
  sender: any,
  isGroup: boolean,
): InboundMessage | null {
  if (isIgnorable(msg)) return null

  const externalMessageId = String(msg?.id ?? '')
  const externalChatId = String(msg?.chatId ?? msg?.peerId?.userId ?? '')
  if (externalMessageId === '' || externalChatId === '') return null

  const content = extractContent(msg)
  const seconds = Number(msg?.date ?? 0)

  return {
    channelId,
    externalMessageId,
    externalChatId,
    phone: senderPhone(sender),
    isGroup,
    fromMe: msg?.out === true,
    pushName: displayName(sender),
    type: content.type,
    body: content.body,
    ...(content.location !== undefined ? { location: content.location } : {}),
    ...(content.contact !== undefined ? { contact: content.contact } : {}),
    ...(msg?.replyTo?.replyToMsgId != null
      ? { quotedExternalMessageId: String(msg.replyTo.replyToMsgId) }
      : {}),
    occurredAt: new Date((seconds > 0 ? seconds : Math.floor(Date.now() / 1000)) * 1000),
  }
}
