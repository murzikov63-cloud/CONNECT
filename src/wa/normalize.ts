import type { InboundMessage, MessageType } from '../types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 79991234567@s.whatsapp.net -> 79991234567; для групп возвращает ''. */
export function jidToPhone(jid: string): string {
  if (jid.endsWith('@g.us')) return ''
  const user = jid.split('@')[0] ?? ''
  // В multi-device JID бывает вида 79991234567:12@s.whatsapp.net
  const digits = (user.split(':')[0] ?? '').replace(/\D/g, '')
  return digits
}

export function phoneToJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

/** Служебные обёртки WhatsApp: исчезающие, «просмотр один раз», редактирование. */
export function unwrapMessage(message: any): any {
  let current = message
  for (let i = 0; i < 5 && current != null; i++) {
    const next =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message
    if (next == null) return current
    current = next
  }
  return current
}

export interface ExtractedContent {
  type: MessageType
  body: string
  mediaMime?: string
  mediaName?: string
  mediaSize?: number
  durationSec?: number
  location?: { lat: number; lng: number; name?: string }
  contact?: { name: string; phone: string }
  quotedExternalMessageId?: string
  /** Ветка сообщения, из которой Baileys будет качать файл. */
  mediaKind?: 'image' | 'video' | 'audio' | 'document' | 'sticker'
}

function phoneFromVcard(vcard: string): string {
  const match = /TEL[^:]*:([+\d\s()-]+)/i.exec(vcard)
  return (match?.[1] ?? '').replace(/\D/g, '')
}

/** Достаёт из сообщения WhatsApp тип, текст и метаданные вложения. */
export function extractContent(rawMessage: any): ExtractedContent {
  const m = unwrapMessage(rawMessage)
  if (m == null) return { type: 'unsupported', body: '' }

  const ctx =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.audioMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.stickerMessage?.contextInfo
  const quoted = typeof ctx?.stanzaId === 'string' ? { quotedExternalMessageId: ctx.stanzaId } : {}

  if (typeof m.conversation === 'string') {
    return { type: 'text', body: m.conversation, ...quoted }
  }
  if (m.extendedTextMessage != null) {
    return { type: 'text', body: m.extendedTextMessage.text ?? '', ...quoted }
  }
  if (m.imageMessage != null) {
    return {
      type: 'image',
      mediaKind: 'image',
      body: m.imageMessage.caption ?? '',
      mediaMime: m.imageMessage.mimetype ?? 'image/jpeg',
      mediaSize: Number(m.imageMessage.fileLength ?? 0),
      ...quoted,
    }
  }
  if (m.videoMessage != null) {
    return {
      type: 'video',
      mediaKind: 'video',
      body: m.videoMessage.caption ?? '',
      mediaMime: m.videoMessage.mimetype ?? 'video/mp4',
      mediaSize: Number(m.videoMessage.fileLength ?? 0),
      durationSec: Number(m.videoMessage.seconds ?? 0),
      ...quoted,
    }
  }
  if (m.audioMessage != null) {
    return {
      // ptt = записанное голосовое, иначе просто аудиофайл
      type: m.audioMessage.ptt === true ? 'voice' : 'audio',
      mediaKind: 'audio',
      body: '',
      mediaMime: m.audioMessage.mimetype ?? 'audio/ogg',
      mediaSize: Number(m.audioMessage.fileLength ?? 0),
      durationSec: Number(m.audioMessage.seconds ?? 0),
      ...quoted,
    }
  }
  if (m.documentMessage != null) {
    return {
      type: 'document',
      mediaKind: 'document',
      body: m.documentMessage.caption ?? '',
      mediaMime: m.documentMessage.mimetype ?? 'application/octet-stream',
      mediaName: m.documentMessage.fileName ?? 'file',
      mediaSize: Number(m.documentMessage.fileLength ?? 0),
      ...quoted,
    }
  }
  if (m.stickerMessage != null) {
    return {
      type: 'sticker',
      mediaKind: 'sticker',
      body: '',
      mediaMime: m.stickerMessage.mimetype ?? 'image/webp',
      mediaSize: Number(m.stickerMessage.fileLength ?? 0),
      ...quoted,
    }
  }
  const loc = m.locationMessage ?? m.liveLocationMessage
  if (loc != null) {
    return {
      type: 'location',
      body: loc.name ?? '',
      location: {
        lat: Number(loc.degreesLatitude ?? 0),
        lng: Number(loc.degreesLongitude ?? 0),
        ...(typeof loc.name === 'string' ? { name: loc.name } : {}),
      },
      ...quoted,
    }
  }
  if (m.contactMessage != null) {
    return {
      type: 'contact',
      body: m.contactMessage.displayName ?? '',
      contact: {
        name: m.contactMessage.displayName ?? '',
        phone: phoneFromVcard(m.contactMessage.vcard ?? ''),
      },
      ...quoted,
    }
  }
  if (m.contactsArrayMessage != null) {
    const first = m.contactsArrayMessage.contacts?.[0]
    return {
      type: 'contact',
      body: first?.displayName ?? '',
      contact: {
        name: first?.displayName ?? '',
        phone: phoneFromVcard(first?.vcard ?? ''),
      },
      ...quoted,
    }
  }

  return { type: 'unsupported', body: '', ...quoted }
}

/** Сообщения, которые не надо показывать менеджеру вообще. */
export function isIgnorableMessage(rawMessage: any): boolean {
  const m = unwrapMessage(rawMessage)
  if (m == null) return true
  return (
    m.protocolMessage != null ||
    m.reactionMessage != null ||
    m.senderKeyDistributionMessage != null ||
    m.pollUpdateMessage != null ||
    Object.keys(m).length === 0
  )
}

/**
 * Настоящий адрес собеседника.
 *
 * WhatsApp постепенно прячет телефоны за внутренним номером вида
 * «12345@lid». По такому адресу человека не опознать: телефона в нём нет,
 * и карточка в amoCRM завелась бы на пустое место. Телефонный адрес
 * WhatsApp кладёт рядом — берём его. Если не положил, разговор пропускаем:
 * лучше не показать сообщение, чем завести карточку неизвестно на кого.
 */
export function realJid(key: any): string {
  const jid: string = key?.remoteJid ?? ''
  if (!jid.endsWith('@lid')) return jid
  const alt: string = key?.senderPn ?? key?.participantPn ?? key?.remoteJidAlt ?? ''
  return alt.endsWith('@s.whatsapp.net') ? alt : ''
}

/** Рассылки и каналы WhatsApp — не переписка с клиентом. */
export function isBroadcastJid(jid: string): boolean {
  return jid.endsWith('@newsletter') || jid.endsWith('@broadcast') || jid === 'status@broadcast'
}

export function normalizeInbound(channelId: string, msg: any): InboundMessage | null {
  const externalChatId = realJid(msg?.key)
  const externalMessageId: string = msg?.key?.id ?? ''
  if (externalChatId === '' || externalMessageId === '') return null
  if (isBroadcastJid(externalChatId)) return null
  if (msg.message == null || isIgnorableMessage(msg.message)) return null

  const content = extractContent(msg.message)
  const tsRaw = msg.messageTimestamp
  const seconds = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw?.low ?? tsRaw ?? 0)

  return {
    channelId,
    externalMessageId,
    externalChatId,
    phone: jidToPhone(externalChatId),
    isGroup: isGroupJid(externalChatId),
    fromMe: msg?.key?.fromMe === true,
    pushName: msg.pushName ?? '',
    type: content.type,
    body: content.body,
    ...(content.location !== undefined ? { location: content.location } : {}),
    ...(content.contact !== undefined ? { contact: content.contact } : {}),
    ...(content.quotedExternalMessageId !== undefined
      ? { quotedExternalMessageId: content.quotedExternalMessageId }
      : {}),
    occurredAt: new Date((seconds > 0 ? seconds : Math.floor(Date.now() / 1000)) * 1000),
  }
}
