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

/**
 * Ищет контакт по телефону. Пустой телефон — сразу null, без запроса.
 *
 * Искать приходится в двух видах. amoCRM сопоставляет номер как строку:
 * запрос «79660388883» не находит карточку, где записано «9660388883».
 * С сайта номер приходит в местном виде, из мессенджера — всегда
 * в международном, и без второй попытки на одного человека заводится
 * второй контакт, а под него — вторая сделка. Проверено живьём.
 *
 * Вторая попытка — последние десять цифр, то есть номер без кода страны.
 * Это верно для российских номеров; для иностранных вторая попытка просто
 * ничего не найдёт.
 */
export async function findContactByPhone(phone: string): Promise<AmoContact | null> {
  const digits = phone.replace(/\D/g, '')
  if (digits === '') return null

  const national = digits.slice(-10)
  const variants = national !== digits && national.length === 10 ? [digits, national] : [digits]

  for (const query of variants) {
    const res = await request<{ _embedded?: { contacts?: AmoContact[] } }>(
      'GET',
      `/api/v4/contacts?query=${encodeURIComponent(query)}&limit=1`,
    )
    const found = res._embedded?.contacts?.[0]
    if (found !== undefined) return found
  }
  return null
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
export async function linkChatToContact(contactId: number, amoChatId: string): Promise<boolean> {
  try {
    await request('POST', '/api/v4/contacts/chats', [{ contact_id: contactId, chat_id: amoChatId }])
    logger.info({ contactId, amoChatId }, 'чат привязан к контакту')
    return true
  } catch (err) {
    // Переписка уже висит на какой-то карточке. Перевесить её amoCRM
    // не даёт, но это и не беда: сообщение всё равно видно там, где она
    // висит. Ронять из-за этого доставку нельзя — иначе входящее будет
    // вечно ходить по кругу повторов и в итоге потеряется.
    const alreadyLinked =
      err instanceof AmoRestError && err.status === 400 && err.message.includes('AlreadyExists')
    if (!alreadyLinked) throw err
    logger.info({ contactId, amoChatId }, 'переписка уже привязана к другой карточке')
    return false
  }
}

/** Телефоны из карточки контакта — их может быть несколько. */
export async function contactPhones(contactId: number): Promise<{ name: string; phones: string[] }> {
  const res = await request<{
    name?: string
    custom_fields_values?: { field_code?: string; values?: { value?: string }[] }[]
  }>('GET', `/api/v4/contacts/${contactId}`)

  const phones = (res.custom_fields_values ?? [])
    .filter((f) => f.field_code === 'PHONE')
    .flatMap((f) => f.values ?? [])
    .map((v) => String(v.value ?? '').replace(/\D/g, ''))
    .filter((v) => v.length >= 10)

  return { name: res.name ?? '', phones: [...new Set(phones)] }
}

/** Контакты, привязанные к сделке. */
export async function leadContactIds(leadId: number): Promise<number[]> {
  const res = await request<{ _embedded?: { contacts?: { id: number }[] } }>(
    'GET',
    `/api/v4/leads/${leadId}?with=contacts`,
  )
  return (res._embedded?.contacts ?? []).map((c) => c.id)
}

export interface AmoWebhook {
  id: number
  destination: string
  settings: string[]
}

export async function listWebhooks(): Promise<AmoWebhook[]> {
  const res = await request<{ _embedded?: { webhooks?: AmoWebhook[] } }>('GET', '/api/v4/webhooks')
  return res._embedded?.webhooks ?? []
}

export async function subscribeWebhook(destination: string, settings: string[]): Promise<void> {
  await request('POST', '/api/v4/webhooks', { destination, settings })
  logger.info({ destination, settings }, 'подписка на события amoCRM оформлена')
}

export async function checkConnection(): Promise<{ id: number; name: string }> {
  return request('GET', '/api/v4/account')
}
