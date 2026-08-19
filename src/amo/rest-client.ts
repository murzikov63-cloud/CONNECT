import { config } from '../config/index.js'
import { log } from '../logger/index.js'

const logger = log('amo-rest')

/**
 * Работа с обычным API amoCRM (v4): контакты, сделки, привязка чатов.
 * Ходим по долгосрочному токену — цикл обновления токенов не нужен,
 * но токен конечен: следить за сроком (см. README).
 */

export class AmoRestError extends Error {
  readonly status: number

  constructor(status: number, path: string, body: string) {
    super(`amoCRM ответил ${status} на ${path}: ${body.slice(0, 300)}`)
    this.status = status
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  if (config.AMO_LONG_TOKEN === '' || config.AMO_SUBDOMAIN === '') {
    throw new Error('Не заданы AMO_SUBDOMAIN и AMO_LONG_TOKEN')
  }

  const response = await fetch(`https://${config.AMO_SUBDOMAIN}.amocrm.ru${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.AMO_LONG_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  // 204 — «нашлось ноль», это не ошибка.
  if (response.status === 204) return {} as T

  const text = await response.text()
  if (!response.ok) {
    logger.error({ path, status: response.status }, 'ошибка API amoCRM')
    throw new AmoRestError(response.status, path, text)
  }
  return (text === '' ? {} : JSON.parse(text)) as T
}

export interface AmoContact {
  id: number
  name: string
}

/** Ищет контакт по телефону. Пустой телефон — сразу null, без запроса. */
export async function findContactByPhone(phone: string): Promise<AmoContact | null> {
  const digits = phone.replace(/\D/g, '')
  if (digits === '') return null

  const res = await request<{ _embedded?: { contacts?: AmoContact[] } }>(
    'GET',
    `/api/v4/contacts?query=${encodeURIComponent(digits)}&limit=1`,
  )
  return res._embedded?.contacts?.[0] ?? null
}

export async function createContact(name: string, phone: string): Promise<AmoContact> {
  const digits = phone.replace(/\D/g, '')
  const payload: Record<string, unknown> = { name: name === '' ? 'Без имени' : name }

  if (digits !== '') {
    payload['custom_fields_values'] = [
      { field_code: 'PHONE', values: [{ value: digits, enum_code: 'WORK' }] },
    ]
  }

  const res = await request<{ _embedded?: { contacts?: AmoContact[] } }>('POST', '/api/v4/contacts', [
    payload,
  ])
  const contact = res._embedded?.contacts?.[0]
  if (contact === undefined) throw new Error('amoCRM не вернул созданный контакт')
  logger.info({ contactId: contact.id }, 'контакт создан')
  return contact
}

export interface AmoLead {
  id: number
}

/** Действующая сделка контакта: ту, что не закрыта. */
export async function findOpenLeadForContact(contactId: number): Promise<AmoLead | null> {
  const res = await request<{
    _embedded?: { leads?: { id: number; status_id: number; closed_at: number | null }[] }
  }>('GET', `/api/v4/leads?filter[contacts][0]=${contactId}&limit=50`)

  const leads = res._embedded?.leads ?? []
  // 142 — «успешно реализовано», 143 — «закрыто и не реализовано».
  const open = leads.find((l) => l.status_id !== 142 && l.status_id !== 143)
  return open ?? null
}

export async function createLead(
  name: string,
  contactId: number,
  pipelineId: number | null,
  statusId: number | null,
): Promise<AmoLead> {
  const payload: Record<string, unknown> = {
    name,
    _embedded: { contacts: [{ id: contactId }] },
  }
  if (pipelineId !== null) payload['pipeline_id'] = pipelineId
  if (statusId !== null) payload['status_id'] = statusId

  const res = await request<{ _embedded?: { leads?: AmoLead[] } }>('POST', '/api/v4/leads', [payload])
  const lead = res._embedded?.leads?.[0]
  if (lead === undefined) throw new Error('amoCRM не вернул созданную сделку')
  logger.info({ leadId: lead.id, contactId }, 'сделка создана')
  return lead
}

/**
 * Привязывает чат к контакту — после этого переписка видна в карточке.
 * Без этого сообщения уходят «в никуда»: чат существует, но не показан.
 */
export async function linkChatToContact(contactId: number, amoChatId: string): Promise<void> {
  await request('POST', '/api/v4/contacts/chats', [{ contact_id: contactId, chat_id: amoChatId }])
  logger.info({ contactId, amoChatId }, 'чат привязан к контакту')
}

export async function checkConnection(): Promise<{ id: number; name: string }> {
  return request('GET', '/api/v4/account')
}
