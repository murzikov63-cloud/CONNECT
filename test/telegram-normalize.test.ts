import { describe, expect, it } from 'vitest'
import {
  displayName,
  extractContent,
  isIgnorable,
  normalizeInbound,
  senderPhone,
} from '../src/telegram/normalize.js'

const CH = '22222222-2222-2222-2222-222222222222'

const doc = (mime: string, attrs: unknown[]) => ({
  className: 'MessageMediaDocument',
  document: { mimeType: mime, attributes: attrs },
})

describe('разбор сообщений Телеграма', () => {
  it('простой текст', () => {
    expect(extractContent({ message: 'привет' })).toMatchObject({
      type: 'text',
      body: 'привет',
      hasMedia: false,
    })
  })

  it('фото с подписью', () => {
    const c = extractContent({ message: 'смотрите', media: { className: 'MessageMediaPhoto' } })
    expect(c).toMatchObject({ type: 'image', body: 'смотрите', hasMedia: true })
  })

  it('голосовое отличается от аудиофайла', () => {
    const voice = extractContent({
      media: doc('audio/ogg', [{ className: 'DocumentAttributeAudio', voice: true, duration: 5 }]),
    })
    const audio = extractContent({
      media: doc('audio/mpeg', [{ className: 'DocumentAttributeAudio', voice: false, duration: 5 }]),
    })
    expect(voice.type).toBe('voice')
    expect(audio.type).toBe('audio')
    expect(voice.durationSec).toBe(5)
  })

  it('видео распознаётся по признаку, а не по типу файла', () => {
    const c = extractContent({
      media: doc('video/mp4', [{ className: 'DocumentAttributeVideo', duration: 12 }]),
    })
    expect(c).toMatchObject({ type: 'video', durationSec: 12, hasMedia: true })
  })

  it('стикер не считается картинкой', () => {
    const c = extractContent({
      media: doc('image/webp', [{ className: 'DocumentAttributeSticker' }]),
    })
    expect(c.type).toBe('sticker')
  })

  it('документ сохраняет имя файла', () => {
    const c = extractContent({
      media: doc('application/pdf', [
        { className: 'DocumentAttributeFilename', fileName: 'смета.pdf' },
      ]),
    })
    expect(c).toMatchObject({ type: 'document', mediaName: 'смета.pdf' })
  })

  it('геометка', () => {
    const c = extractContent({
      media: { className: 'MessageMediaGeo', geo: { lat: 55.75, long: 37.61 } },
    })
    expect(c.type).toBe('location')
    expect(c.location).toEqual({ lat: 55.75, lng: 37.61 })
  })

  it('место с названием', () => {
    const c = extractContent({
      media: { className: 'MessageMediaVenue', geo: { lat: 1, long: 2 }, title: 'Офис' },
    })
    expect(c.location).toEqual({ lat: 1, lng: 2, name: 'Офис' })
  })

  it('контакт', () => {
    const c = extractContent({
      media: {
        className: 'MessageMediaContact',
        firstName: 'Иван',
        lastName: 'Петров',
        phoneNumber: '+7 999 123-45-67',
      },
    })
    expect(c.contact).toEqual({ name: 'Иван Петров', phone: '79991234567' })
  })

  it('незнакомое вложение не роняет разбор', () => {
    expect(extractContent({ media: { className: 'MessageMediaPoll' } }).type).toBe('unsupported')
  })
})

describe('что не показываем менеджеру', () => {
  it('служебные события отбрасываются', () => {
    expect(isIgnorable({ action: { className: 'MessageActionChatAddUser' } })).toBe(true)
  })

  it('пустое сообщение без вложения отбрасывается', () => {
    expect(isIgnorable({ message: '' })).toBe(true)
  })

  it('обычный текст остаётся', () => {
    expect(isIgnorable({ message: 'привет' })).toBe(false)
  })
})

describe('имя и телефон собеседника', () => {
  it('имя и фамилия', () => {
    expect(displayName({ firstName: 'Иван', lastName: 'Петров' })).toBe('Иван Петров')
  })

  it('без имени показываем псевдоним', () => {
    expect(displayName({ username: 'ivan' })).toBe('@ivan')
  })

  it('скрытый телефон даёт пустую строку, а не ошибку', () => {
    expect(senderPhone({ firstName: 'Иван' })).toBe('')
    expect(senderPhone(null)).toBe('')
  })

  it('видимый телефон чистится от форматирования', () => {
    expect(senderPhone({ phone: '7 999 123 45 67' })).toBe('79991234567')
  })
})

describe('приведение к общему формату', () => {
  const base = {
    id: 555,
    chatId: 12345,
    message: 'здравствуйте',
    date: 1787000000,
    out: false,
  }
  const sender = { firstName: 'Иван', username: 'ivan', phone: '79991234567' }

  it('собирает тот же формат, что и WhatsApp', () => {
    const m = normalizeInbound(CH, base, sender, false)
    expect(m).toMatchObject({
      channelId: CH,
      externalMessageId: '555',
      externalChatId: '12345',
      phone: '79991234567',
      isGroup: false,
      fromMe: false,
      pushName: 'Иван',
      type: 'text',
      body: 'здравствуйте',
    })
    expect(m?.occurredAt.getTime()).toBe(1787000000 * 1000)
  })

  it('своё отправленное сообщение помечается', () => {
    expect(normalizeInbound(CH, { ...base, out: true }, sender, false)?.fromMe).toBe(true)
  })

  it('ответ на сообщение сохраняет ссылку на исходное', () => {
    const m = normalizeInbound(CH, { ...base, replyTo: { replyToMsgId: 111 } }, sender, false)
    expect(m?.quotedExternalMessageId).toBe('111')
  })

  it('скрытый телефон не мешает принять сообщение', () => {
    const m = normalizeInbound(CH, base, { firstName: 'Аноним' }, false)
    expect(m?.phone).toBe('')
    expect(m?.pushName).toBe('Аноним')
  })

  it('служебное событие отбрасывается', () => {
    expect(normalizeInbound(CH, { ...base, action: {} }, sender, false)).toBeNull()
  })
})

describe('временные обрывы связи', () => {
  it('распознаются и не считаются разлогином', async () => {
    // Раньше любая сетевая заминка присылала владельцу «номер разлогинен,
    // сканируйте QR заново» — хотя сканировать было нечего.
    const { isTemporaryForTests } = await import('../src/telegram/driver.js')
    for (const m of [
      'Cannot send requests while disconnected. Please reconnect.',
      'Error: TIMEOUT',
      'read ECONNRESET',
      'Not connected',
    ]) {
      expect(isTemporaryForTests(m)).toBe(true)
    }
  })

  it('настоящие причины разлогина временными не считаются', async () => {
    const { isTemporaryForTests } = await import('../src/telegram/driver.js')
    expect(isTemporaryForTests('AUTH_KEY_UNREGISTERED')).toBe(false)
    expect(isTemporaryForTests('SESSION_REVOKED')).toBe(false)
  })
})
