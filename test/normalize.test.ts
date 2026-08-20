import { describe, expect, it } from 'vitest'
import {
  extractContent,
  isGroupJid,
  isIgnorableMessage,
  jidToPhone,
  normalizeInbound,
  phoneToJid,
  unwrapMessage,
  isBroadcastJid,
  realJid,
} from '../src/wa/normalize.js'

const NUMBER_ID = '11111111-1111-1111-1111-111111111111'

describe('jidToPhone', () => {
  it('достаёт телефон из обычного jid', () => {
    expect(jidToPhone('79991234567@s.whatsapp.net')).toBe('79991234567')
  })

  it('отрезает суффикс устройства multi-device', () => {
    expect(jidToPhone('79991234567:12@s.whatsapp.net')).toBe('79991234567')
  })

  it('для группы телефона нет', () => {
    expect(jidToPhone('120363000000000000@g.us')).toBe('')
    expect(isGroupJid('120363000000000000@g.us')).toBe(true)
  })

  it('phoneToJid обратно собирает jid', () => {
    expect(phoneToJid('+7 (999) 123-45-67')).toBe('79991234567@s.whatsapp.net')
  })
})

describe('unwrapMessage', () => {
  it('разворачивает исчезающее сообщение', () => {
    const inner = { conversation: 'привет' }
    expect(unwrapMessage({ ephemeralMessage: { message: inner } })).toEqual(inner)
  })

  it('разворачивает вложенные обёртки', () => {
    const inner = { conversation: 'привет' }
    const wrapped = { ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } }
    expect(unwrapMessage(wrapped)).toEqual(inner)
  })
})

describe('extractContent', () => {
  it('простой текст', () => {
    expect(extractContent({ conversation: 'привет' })).toMatchObject({
      type: 'text',
      body: 'привет',
    })
  })

  it('текст с цитатой', () => {
    const c = extractContent({
      extendedTextMessage: { text: 'ответ', contextInfo: { stanzaId: 'ABC123' } },
    })
    expect(c).toMatchObject({ type: 'text', body: 'ответ', quotedExternalMessageId: 'ABC123' })
  })

  it('фото с подписью', () => {
    const c = extractContent({
      imageMessage: { caption: 'вот так', mimetype: 'image/jpeg', fileLength: 4096 },
    })
    expect(c).toMatchObject({
      type: 'image',
      body: 'вот так',
      mediaKind: 'image',
      mediaMime: 'image/jpeg',
      mediaSize: 4096,
    })
  })

  it('различает голосовое и аудиофайл', () => {
    expect(extractContent({ audioMessage: { ptt: true, seconds: 7 } }).type).toBe('voice')
    expect(extractContent({ audioMessage: { ptt: false, seconds: 7 } }).type).toBe('audio')
  })

  it('документ сохраняет имя файла', () => {
    const c = extractContent({
      documentMessage: { fileName: 'смета.pdf', mimetype: 'application/pdf', fileLength: 10 },
    })
    expect(c).toMatchObject({ type: 'document', mediaName: 'смета.pdf' })
  })

  it('локация', () => {
    const c = extractContent({
      locationMessage: { degreesLatitude: 55.75, degreesLongitude: 37.61, name: 'Офис' },
    })
    expect(c.type).toBe('location')
    expect(c.location).toEqual({ lat: 55.75, lng: 37.61, name: 'Офис' })
  })

  it('контакт вытаскивает телефон из vcard', () => {
    const vcard = 'BEGIN:VCARD\nFN:Иван\nTEL;type=CELL:+7 999 123-45-67\nEND:VCARD'
    const c = extractContent({ contactMessage: { displayName: 'Иван', vcard } })
    expect(c.contact).toEqual({ name: 'Иван', phone: '79991234567' })
  })

  it('незнакомый тип не роняет разбор', () => {
    expect(extractContent({ somethingBrandNew: {} }).type).toBe('unsupported')
  })
})

describe('isIgnorableMessage', () => {
  it('служебные сообщения отбрасываются', () => {
    expect(isIgnorableMessage({ protocolMessage: {} })).toBe(true)
    expect(isIgnorableMessage({ reactionMessage: {} })).toBe(true)
    expect(isIgnorableMessage({})).toBe(true)
  })

  it('обычный текст не отбрасывается', () => {
    expect(isIgnorableMessage({ conversation: 'привет' })).toBe(false)
  })
})

describe('normalizeInbound', () => {
  const base = {
    key: { remoteJid: '79991234567@s.whatsapp.net', id: 'WAMSG1', fromMe: false },
    pushName: 'Иван',
    messageTimestamp: 1787000000,
    message: { conversation: 'здравствуйте' },
  }

  it('собирает внутренний формат', () => {
    const msg = normalizeInbound(NUMBER_ID, base)
    expect(msg).not.toBeNull()
    expect(msg).toMatchObject({
      channelId: NUMBER_ID,
      externalMessageId: 'WAMSG1',
      phone: '79991234567',
      isGroup: false,
      fromMe: false,
      pushName: 'Иван',
      type: 'text',
      body: 'здравствуйте',
    })
    expect(msg?.occurredAt.getTime()).toBe(1787000000 * 1000)
  })

  it('помечает сообщения, отправленные с самого телефона', () => {
    const msg = normalizeInbound(NUMBER_ID, { ...base, key: { ...base.key, fromMe: true } })
    expect(msg?.fromMe).toBe(true)
  })

  it('служебное сообщение отбрасывается', () => {
    expect(normalizeInbound(NUMBER_ID, { ...base, message: { protocolMessage: {} } })).toBeNull()
  })

  it('без id или чата — null', () => {
    expect(normalizeInbound(NUMBER_ID, { ...base, key: { remoteJid: '', id: '' } })).toBeNull()
  })

  it('timestamp в виде Long тоже понимается', () => {
    const msg = normalizeInbound(NUMBER_ID, { ...base, messageTimestamp: { low: 1787000001 } })
    expect(msg?.occurredAt.getTime()).toBe(1787000001 * 1000)
  })
})

describe('новые адреса WhatsApp', () => {
  it('внутренний адрес заменяется телефонным, если он рядом', () => {
    const key = { remoteJid: '120065978589278@lid', senderPn: '79660388883@s.whatsapp.net' }
    expect(realJid(key)).toBe('79660388883@s.whatsapp.net')
  })

  it('без телефонного адреса разговор пропускаем', () => {
    // Иначе карточка в amoCRM заводится на внутренний номер WhatsApp,
    // а это не человек и не телефон.
    expect(realJid({ remoteJid: '120065978589278@lid' })).toBe('')
  })

  it('обычный адрес не трогаем', () => {
    expect(realJid({ remoteJid: '79660388883@s.whatsapp.net' })).toBe('79660388883@s.whatsapp.net')
  })

  it('рассылки и каналы узнаются', () => {
    expect(isBroadcastJid('status@broadcast')).toBe(true)
    expect(isBroadcastJid('123@newsletter')).toBe(true)
    expect(isBroadcastJid('79660388883@s.whatsapp.net')).toBe(false)
  })
})
