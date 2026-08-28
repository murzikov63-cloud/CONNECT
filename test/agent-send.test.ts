import { describe, expect, it } from 'vitest'
import { agentSendSchema, pickChat } from '../src/api/agent-send.js'
import type { ChatCandidate } from '../src/api/agent-send.js'

const chat = (kind: string, last: string | null): ChatCandidate => ({
  chat_id: `${kind}-1`,
  channel_id: 'ch',
  external_chat_id: 'x',
  phone: '79000000000',
  channel_kind: kind,
  last_message_at: last === null ? null : new Date(last),
})

describe('выбор переписки для агента', () => {
  it('при одной переписке берёт её', () => {
    expect(pickChat([chat('whatsapp', '2026-08-01')])?.channel_kind).toBe('whatsapp')
  })

  it('без указания мессенджера пишет туда, где разговор был последним', () => {
    const rows = [chat('whatsapp', '2026-08-01'), chat('telegram', '2026-08-20')]
    expect(pickChat(rows)?.channel_kind).toBe('telegram')
  })

  it('явно названный мессенджер главнее свежести', () => {
    const rows = [chat('whatsapp', '2026-08-01'), chat('telegram', '2026-08-20')]
    expect(pickChat(rows, 'whatsapp')?.channel_kind).toBe('whatsapp')
  })

  it('переписка без сообщений проигрывает любой живой', () => {
    const rows = [chat('max', null), chat('whatsapp', '2026-07-01')]
    expect(pickChat(rows)?.channel_kind).toBe('whatsapp')
  })

  it('если названного мессенджера нет — честный отказ, а не подмена', () => {
    expect(pickChat([chat('whatsapp', '2026-08-01')], 'max')).toBeNull()
  })

  it('пустой список — null', () => {
    expect(pickChat([])).toBeNull()
  })
})

describe('разбор запроса на отправку', () => {
  it('без адресата не принимается', () => {
    expect(agentSendSchema.safeParse({ text: 'привет' }).success).toBe(false)
  })

  it('пустой текст не принимается', () => {
    expect(agentSendSchema.safeParse({ leadId: 1, text: '' }).success).toBe(false)
  })

  it('сделка числом из строки — amoCRM отдаёт id и так, и так', () => {
    const r = agentSendSchema.safeParse({ leadId: '32525291', text: 'привет' })
    expect(r.success && r.data.leadId).toBe(32525291)
  })

  it('чужой мессенджер не принимается', () => {
    expect(agentSendSchema.safeParse({ leadId: 1, kind: 'viber', text: 'x' }).success).toBe(false)
  })
})

describe('порядок мессенджеров при первом сообщении', () => {
  it('чат, заведённый по телефону, идёт в обход выбора по свежести', () => {
    // pickChat решает только между уже существующими переписками.
    // Когда их нет, чат приходит от openChatForLead и попадает в отправку
    // напрямую — проверяем, что такой чат не отсеивается пустой датой.
    const fresh = chat('whatsapp', null)
    expect(pickChat([fresh])).toBe(fresh)
    expect(pickChat([fresh], 'whatsapp')).toBe(fresh)
  })
})
