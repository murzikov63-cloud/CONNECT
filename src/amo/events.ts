import { sql } from '../db/index.js'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ChannelKind } from '../channels/types.js'
import { channelForKind } from './channels.js'
import { createChat } from './chat-client.js'
import {
  contactPhones,
  leadContactIds,
  linkChatToContact,
  listWebhooks,
  subscribeWebhook,
} from './rest-client.js'

const logger = log('amo-events')

/**
 * Беседы в карточке заводим сами, не дожидаясь клиента.
 *
 * amoCRM предлагает менеджеру мессенджер только тогда, когда беседа
 * с этим человеком в нём уже есть. Пока её нет, кнопки «написать» просто
 * не существует — и заявку, пришедшую с сайта, обработать нечем.
 *
 * Поэтому на каждый новый контакт проверяем его номер во всех мессенджерах
 * и заводим беседу там, где человек есть. В карточке сразу видно, куда ему
 * можно написать, а куда нельзя.
 */

const KINDS: ChannelKind[] = ['telegram', 'whatsapp', 'max']

/** Адрес, по которому amoCRM сообщает о событиях. Тайна — в самом адресе. */
export function eventsPath(secret: string = config.AMO_EVENTS_SECRET): string {
  return `/amo-events/${secret}`
}

/**
 * Достаёт номера новых контактов и сделок из события amoCRM.
 * Она шлёт их полем формы с вложенными скобками — разбираем строкой,
 * чтобы не тащить зависимость ради одного разбора.
 */
export function parseEvent(raw: string): { contacts: number[]; leads: number[] } {
  // Битую строку разбирать всё равно нужно: событие с одним испорченным
  // знаком не повод потерять остальные номера.
  let text = raw.replace(/\+/g, ' ')
  try {
    text = decodeURIComponent(text)
  } catch {
    /* оставляем как есть — номера в нём всё равно видны */
  }
  const pick = (entity: string): number[] => {
    const found = new Set<number>()
    const re = new RegExp(`${entity}\\[add\\]\\[\\d+\\]\\[id\\]=(\\d+)`, 'g')
    for (const m of text.matchAll(re)) found.add(Number(m[1]))
    return [...found]
  }
  return { contacts: pick('contacts'), leads: pick('leads') }
}

/** Подписывается на события. Повторный вызов ничего не меняет. */
export async function ensureSubscription(): Promise<void> {
  if (config.AMO_EVENTS_SECRET === '' || config.AMO_LONG_TOKEN === '') {
    logger.info({}, 'подписка на события amoCRM не настроена')
    return
  }
  const destination = `https://${config.PUBLIC_DOMAIN}${eventsPath()}`
  const existing = await listWebhooks()
  if (existing.some((w) => w.destination === destination)) return
  await subscribeWebhook(destination, ['add_contact', 'add_lead'])
}

/** Заводит беседы во всех мессенджерах, где этот человек есть. */
export async function openChatsForContact(
  manager: ChannelManager,
  contactId: number,
): Promise<void> {
  const { name, phones } = await contactPhones(contactId)
  if (phones.length === 0) {
    logger.info({ contactId }, 'у контакта нет телефона, писать некуда')
    return
  }

  for (const phone of phones) {
    for (const kind of KINDS) {
      await openOne(manager, contactId, kind, phone, name).catch((err: unknown) =>
        logger.warn({ err, kind, contactId }, 'не удалось завести беседу'),
      )
    }
  }
}

async function openOne(
  manager: ChannelManager,
  contactId: number,
  kind: ChannelKind,
  phone: string,
  name: string,
): Promise<void> {
  const opened = await manager.openChatByPhone(kind, phone, name)
  // null — либо номера этого мессенджера нет в сети, либо человека там нет.
  // И то и другое — обычное дело, не авария.
  if (opened === null) return

  const already = await sql<{ amo_chat_id: string | null; amo_contact_id: string | null }[]>`
    select amo_chat_id, amo_contact_id::text as amo_contact_id from chats where id = ${opened.chat_id}
  `
  const row = already[0]
  if (row?.amo_chat_id != null && row.amo_contact_id === String(contactId)) return

  const created = await createChat(channelForKind(kind), `${kind}-${opened.chat_id}`, {
    id: `${kind}-${opened.external_chat_id}`,
    name: name === '' ? 'Клиент' : name,
    profile: { phone },
  })
  await sql`
    update chats set amo_chat_id = ${created.id}, amo_contact_id = ${contactId}, updated_at = now()
    where id = ${opened.chat_id}
  `
  await linkChatToContact(contactId, created.id)
  logger.info({ kind, contactId, chatId: opened.chat_id }, 'беседа заведена в карточке')
}

/** Разбирает событие целиком: и новые контакты, и контакты новых сделок. */
export async function handleEvent(manager: ChannelManager, raw: string): Promise<void> {
  const { contacts, leads } = parseEvent(raw)
  const ids = new Set(contacts)

  for (const leadId of leads) {
    const linked = await leadContactIds(leadId).catch((err: unknown) => {
      logger.warn({ err, leadId }, 'не смог узнать контакты сделки')
      return [] as number[]
    })
    for (const id of linked) ids.add(id)
  }

  for (const id of ids) {
    await openChatsForContact(manager, id).catch((err: unknown) =>
      logger.error({ err, contactId: id }, 'не удалось завести беседы контакту'),
    )
  }
}
