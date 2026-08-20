import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendMessageToAmo } from '../src/amo/chat-client.js'
import type { AmoChannel } from '../src/amo/channels.js'

const channel: AmoChannel = {
  kind: 'telegram',
  channelId: 'канал',
  secretKey: 'секрет',
  scopeId: 'область',
}

const base = {
  conversationId: 'telegram-1',
  msgid: 'msg-1',
  sender: { id: 'telegram-100', name: 'Клиент' },
  type: 'text' as const,
  text: 'привет',
  occurredAt: new Date('2026-08-20T06:00:00Z'),
}

/** Перехватывает тело запроса к amoCRM, ничего наружу не отправляя. */
function captureRequest(): () => Record<string, unknown> {
  let payload: Record<string, unknown> = {}
  vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
    payload = JSON.parse(init.body).payload
    return Promise.resolve(
      new Response(JSON.stringify({ new_message: { msgid: 'x', ref_id: 'y' } }), { status: 200 }),
    )
  })
  return () => payload
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('в какую беседу amoCRM уходит сообщение', () => {
  it('по умолчанию — в нашу', async () => {
    const payload = captureRequest()
    await sendMessageToAmo(channel, base)
    expect(payload()['conversation_id']).toBe('telegram-1')
    expect(payload()['conversation_ref_id']).toBeUndefined()
  })

  it('если менеджер начал разговор из карточки — в беседу карточки', async () => {
    const payload = captureRequest()
    await sendMessageToAmo(channel, { ...base, conversationRefId: 'беседа-карточки' })
    // Одновременно указывать обе нельзя: amoCRM возьмёт нашу, и ответ
    // клиента снова окажется в чужой карточке.
    expect(payload()['conversation_ref_id']).toBe('беседа-карточки')
    expect(payload()['conversation_id']).toBeUndefined()
  })
})
