import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fromAmoType, parseOutgoing, verifyWebhookSignature } from '../src/amo/webhook.js'
import { toAmoType } from '../src/amo/chat-client.js'

const SECRET = 'тестовый-секрет-канала'

describe('подпись вебхука', () => {
  it('ключ другого канала не подходит', () => {
    const body = '{"a":1}'
    const sig = createHmac('sha1', SECRET).update(body).digest('hex')
    // У каждого мессенджера свой канал и свой ключ: подпись одного
    // не должна проходить проверку другого.
    expect(verifyWebhookSignature('ключ-другого-канала', body, sig)).toBe(false)
  })

  it('без подписи не пропускает', () => {
    expect(verifyWebhookSignature(SECRET, '{}', '')).toBe(false)
  })

  it('чужая подпись не проходит', () => {
    expect(verifyWebhookSignature(SECRET, '{}', 'a'.repeat(40))).toBe(false)
  })

  it('верная подпись принимается', () => {
    const body = '{"a":1}'
    const sig = createHmac('sha1', SECRET).update(body).digest('hex')
    expect(verifyWebhookSignature(SECRET, body, sig)).toBe(true)
    expect(verifyWebhookSignature(SECRET, body, sig.toUpperCase())).toBe(true)
    expect(verifyWebhookSignature(SECRET, '{"a":2}', sig)).toBe(false)
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

  it('телефон получателя вытаскивается — по нему находим переписку', () => {
    // Когда менеджер начинает разговор сам, amoCRM заводит беседу с новым
    // идентификатором. Телефон получателя — единственная зацепка.
    const parsed = parseOutgoing({
      account_id: 'acc',
      message: {
        receiver: { id: 'u1', name: 'Антон', phone: '79660388883' },
        sender: { id: 's1', name: 'Анатолий' },
        conversation: { id: '126683c4' },
        message: { id: 'm1', type: 'text', text: 'ку' },
      },
    })
    expect(parsed).toMatchObject({
      receiverPhone: '79660388883',
      receiverName: 'Антон',
      amoChatId: '126683c4',
      conversationClientId: '',
      text: 'ку',
    })
  })

  it('телефон очищается от форматирования', () => {
    const parsed = parseOutgoing({
      message: {
        receiver: { phone: '+7 (966) 038-88-83' },
        conversation: { id: 'c1' },
        message: { id: 'm1', type: 'text' },
      },
    })
    expect(parsed?.receiverPhone).toBe('79660388883')
  })

  it('без телефона получателя разбор не падает', () => {
    const parsed = parseOutgoing({
      message: { conversation: { id: 'c1' }, message: { id: 'm1', type: 'text' } },
    })
    expect(parsed?.receiverPhone).toBe('')
  })

  it('мусор не роняет разбор', () => {
    expect(parseOutgoing({})).toBeNull()
    expect(parseOutgoing({ message: {} })).toBeNull()
    expect(parseOutgoing(null)).toBeNull()
  })
})
