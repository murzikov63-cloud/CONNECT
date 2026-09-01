import { sql } from '../db/index.js'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ChannelKind } from '../channels/types.js'
import { channelForKind } from './channels.js'
import { createChat } from './chat-client.js'
import {
  contactExists,
  leadPreferredMessenger,
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


/** Отличает новое имя беседы от прежних. Время годится: оно не повторится. */
function counter(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Контакты, которыми занимаемся прямо сейчас.
 *
 * О новом человеке amoCRM сообщает дважды — отдельно про контакт и про
 * сделку, — и события приходят в одну секунду. Без этой отметки вся работа
 * делается дважды: второй заход не видит следов первого, потому что тот
 * ещё не закончил.
 */
const вРаботе = new Set<number>()

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
  kinds: ChannelKind[],
): Promise<void> {
  if (вРаботе.has(contactId)) {
    logger.info({ contactId }, 'этим контактом уже занимаемся, второй заход пропускаю')
    return
  }
  вРаботе.add(contactId)
  try {
    await openChats(manager, contactId, kinds)
  } finally {
    вРаботе.delete(contactId)
  }
}

async function openChats(
  manager: ChannelManager,
  contactId: number,
  kinds: ChannelKind[],
): Promise<void> {
  const { name, phones } = await contactPhones(contactId)
  if (phones.length === 0) {
    logger.info({ contactId }, 'у контакта нет телефона, писать некуда')
    return
  }

  for (const phone of phones) {
    for (const kind of kinds) {
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

  const already = await sql<
    { amo_chat_id: string | null; amo_contact_id: string | null; amo_conversation_key: string | null }[]
  >`
    select amo_chat_id, amo_contact_id::text as amo_contact_id, amo_conversation_key
    from chats where id = ${opened.chat_id}
  `
  const row = already[0]
  if (row?.amo_chat_id != null && row.amo_contact_id === String(contactId)) return

  const user = {
    id: `${kind}-${opened.external_chat_id}`,
    name: name === '' ? 'Клиент' : name,
    profile: { phone },
  }
  const channel = channelForKind(kind)

  let key = row?.amo_conversation_key ?? `${kind}-${opened.chat_id}`
  let created = await createChat(channel, key, user)
  let linked = await linkChatToContact(contactId, created.id)

  if (!linked) {
    // Беседа висит на другой карточке. Заводить новую можно только если
    // той карточки больше нет: иначе один и тот же человек, заведённый
    // в amoCRM дважды, перетягивает переписку туда-сюда, и на каждое
    // событие появляется ещё одна беседа. Проверено живьём — за минуту
    // их набралось четыре.
    const previous = row?.amo_contact_id
    if (previous != null && (await contactExists(Number(previous)))) {
      logger.info(
        { kind, chatId: opened.chat_id, карточка: previous },
        'переписка уже в другой карточке этого человека, оставляю там',
      )
      return
    }

    // Прежней карточки нет — переписка осиротела. Заводим беседу заново
    // под другим именем: старая остаётся при удалённой карточке.
    key = `${kind}-${opened.chat_id}-${counter()}`
    created = await createChat(channel, key, user)
    linked = await linkChatToContact(contactId, created.id)
    logger.info({ kind, chatId: opened.chat_id, key }, 'завёл беседу заново под новым именем')
  }

  await sql`
    update chats set
      amo_chat_id = ${created.id},
      amo_conversation_key = ${key},
      amo_contact_id = ${contactId},
      amo_started_chat_id = null,
      updated_at = now()
    where id = ${opened.chat_id}
  `
  logger.info({ kind, contactId, chatId: opened.chat_id }, 'беседа заведена в карточке')
}

/**
 * Разбирает событие: заводим переписку только в том мессенджере, который
 * клиент назвал сам в заявке.
 *
 * Заводить сразу во всех трёх — плохая мысль: чтобы завести переписку,
 * человека надо найти по номеру, а массовый поиск мессенджеры считают
 * рассылкой. Телеграм за это ограничил нам номер 1 сентября. Остальные
 * мессенджеры включим позже и по делу — например, на другом этапе
 * воронки, если клиент не отвечает в своём.
 */
export async function handleEvent(manager: ChannelManager, raw: string): Promise<void> {
  const { contacts, leads } = parseEvent(raw)

  for (const leadId of leads) {
    const выбор = await leadPreferredMessenger(leadId).catch((err: unknown) => {
      logger.warn({ err, leadId }, 'не смог прочитать выбранный клиентом мессенджер')
      return null
    })
    if (выбор === null) {
      logger.info({ leadId }, 'клиент не назвал мессенджер — переписку пока не заводим')
      continue
    }

    const linked = await leadContactIds(leadId).catch((err: unknown) => {
      logger.warn({ err, leadId }, 'не смог узнать контакты сделки')
      return [] as number[]
    })
    for (const id of linked) {
      await openChatsForContact(manager, id, [выбор]).catch((err: unknown) =>
        logger.error({ err, contactId: id }, 'не удалось завести беседу контакту'),
      )
    }
  }

  // Контакт без сделки: чем пользуется человек — неизвестно, а угадывать
  // поиском по номерам мы больше не будем.
  if (contacts.length > 0 && leads.length === 0) {
    logger.info({ контактов: contacts.length }, 'контакт без сделки — мессенджер неизвестен, жду')
  }
}
