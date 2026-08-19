import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fromAmoType, parseOutgoing, verifyWebhookSignature } from '../src/amo/webhook.js'
import { toAmoType } from '../src/amo/chat-client.js'

const SECRET = process.env['AMO_CHAT_SECRET_KEY'] ?? ''

describe('подпись вебхука', () => {
  it('без подписи не пропускает', () => {
    expect(verifyWebhookSignature('{}', '')).toBe(false)
  })

  it('чужая подпись не проходит', () => {
    expect(verifyWebhookSignature('{}', 'a'.repeat(40))).toBe(false)
  })

  it('верная подпись принимается', () => {
    if (SECRET === '') return
    const body = '{"a":1}'
    const sig = createHmac('sha1', SECRET).update(body).digest('hex')
    expect(verifyWebhookSignature(body, sig)).toBe(true)
    expect(verifyWebhookSignature(body, sig.toUpperCase())).toBe(true)
    expect(verifyWebhookSignature('{"a":2}', sig)).toBe(false)
  })
})

describe('перевод типов сообщений', () => {
  it('туда и обратно без потерь для основных типов', () => {
    for (const t of ['image', 'document', 'video', 'voice', 'audio', 'sticker', 'location', 'contact']) {
      expect(fromAmoType(toAmoType(t))).toBe(t)
    }
  })

  it('картинка называется в amoCRM picture, документ — file', () => {
    expect(toAmoType('image')).toBe('picture')
    expect(toAmoType('document')).toBe('file')
  })

  it('незнакомое уходит текстом, а не теряется', () => {
    expect(toAmoType('unsupported')).toBe('text')
    expect(fromAmoType(undefined)).toBe('text')
    expect(fromAmoType('что-то новое')).toBe('text')
  })
})

describe('разбор вебхука с ответом менеджера', () => {
  it('понимает вложенный формат', () => {
    const parsed = parseOutgoing({
      account_id: 'acc',
      message: {
        conversation: { id: 'amo-chat-1', client_id: 'telegram-42' },
        message: { id: 'amo-msg-1', type: 'text', text: 'Добрый день!' },
      },
    })
    expect(parsed).toMatchObject({
      amoChatId: 'amo-chat-1',
      conversationClientId: 'telegram-42',
      amoMessageId: 'amo-msg-1',
      type: 'text',
      text: 'Добрый день!',
    })
  })

  it('понимает плоский формат', () => {
    const parsed = parseOutgoing({
      conversation_id: 'telegram-42',
      msgid: 'amo-msg-2',
      type: 'picture',
      text: 'вот фото',
      media: 'https://amo/file.jpg',
    })
    expect(parsed).toMatchObject({
      conversationClientId: 'telegram-42',
      amoMessageId: 'amo-msg-2',
      type: 'image',
      media: 'https://amo/file.jpg',
    })
  })

  it('файл сохраняет имя и размер', () => {
    const parsed = parseOutgoing({
      message: {
        conversation: { id: 'c1' },
        message: {
          id: 'm1',
          type: 'file',
          text: '',
          media: 'https://amo/doc.pdf',
          file_name: 'смета.pdf',
          file_size: 1024,
        },
      },
    })
    expect(parsed).toMatchObject({ type: 'document', fileName: 'смета.pdf', fileSize: 1024 })
  })

  it('пустое вложение не превращается в ссылку', () => {
    const parsed = parseOutgoing({
      message: { conversation: { id: 'c1' }, message: { id: 'm1', type: 'text', media: '' } },
    })
    expect(parsed?.media).toBeUndefined()
  })

  it('мусор не роняет разбор', () => {
    expect(parseOutgoing({})).toBeNull()
    expect(parseOutgoing({ message: {} })).toBeNull()
    expect(parseOutgoing(null)).toBeNull()
  })
})
