/**
 * Отправка сообщения от лица агента продаж.
 *
 * Отличие от всего остального исходящего: обычные исходящие приходят
 * вебхуком из amoCRM, то есть amoCRM про них уже знает. Здесь инициатор —
 * наш бот, и amoCRM про сообщение не знает ничего. Поэтому после успешной
 * отправки его нужно ещё и показать в карточке — тем же путём, каким
 * туда попадают ответы менеджера с телефона (см. amo/inbound.ts).
 */
import { z } from 'zod'
import { contactPhones, leadContactIds, leadPreferredMessenger } from '../amo/rest-client.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ChannelKind } from '../channels/types.js'

const logger = log('agent-send')

/** Тело запроса к POST /api/messages. */
export const agentSendSchema = z
  .object({
    /** Сделка amoCRM — основной способ адресации: агент работает по сделке. */
    leadId: z.coerce.number().int().positive().optional(),
    /** Прямое указание переписки, если она уже известна вызывающему. */
    chatId: z.string().min(1).optional(),
    /** В каком мессенджере писать, если у сделки их несколько. */
    kind: z.enum(['whatsapp', 'telegram', 'max']).optional(),
    text: z.string().min(1).max(4096),
    /**
     * Ключ повтора: n8n перезапускает узел при любой сетевой ошибке,
     * и без него одобренный черновик ушёл бы клиенту дважды.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.leadId !== undefined || v.chatId !== undefined, {
    message: 'нужен leadId или chatId',
  })

export type AgentSendBody = z.infer<typeof agentSendSchema>

/** Переписка-кандидат: у одной сделки их может быть несколько. */
export interface ChatCandidate {
  chat_id: string
  channel_id: string
  external_chat_id: string
  phone: string | null
  channel_kind: string
  last_message_at: Date | null
}

/**
 * Куда писать, если у сделки несколько переписок.
 *
 * Явно названный мессенджер главнее всего. Дальше — та переписка, где
 * разговор шёл последним: клиент отвечает там, где писал сам, и переносить
 * его в другой мессенджер без причины не нужно. Переписка вообще без
 * сообщений — последний вариант: обычно это заведённая про запас беседа.
 */
export function pickChat(rows: ChatCandidate[], kind?: string): ChatCandidate | null {
  const pool = kind === undefined ? rows : rows.filter((r) => r.channel_kind === kind)
  if (pool.length === 0) return null

  const byRecency = [...pool].sort((a, b) => {
    const at = a.last_message_at?.getTime() ?? 0
    const bt = b.last_message_at?.getTime() ?? 0
    return bt - at
  })
  return byRecency[0] ?? null
}

/**
 * Завести переписку по сделке, в которой её ещё нет.
 *
 * Ровно случай заявки с сайта: сделка есть, человек нам не писал ни разу,
 * и писать первыми приходится нам. Телефон берём из карточки контакта —
 * в сделке его нет — и ищем человека в мессенджерах по очереди.
 *
 * Сделку и контакт проставляем сразу же. Без этого публикация в amoCRM
 * решит, что переписка ничья, и заведёт второй контакт с тем же телефоном
 * и вторую сделку — вместо той, что пришла с сайта.
 */
export async function openChatForLead(
  manager: ChannelManager,
  leadId: number,
  kind: ChannelKind | undefined,
  order: ChannelKind[],
): Promise<ChatCandidate | null> {
  const contactIds = await leadContactIds(leadId)
  if (contactIds.length === 0) {
    logger.info({ leadId }, 'у сделки нет контакта — писать некому')
    return null
  }

  const targets: { contactId: number; name: string; phone: string }[] = []
  for (const contactId of contactIds) {
    const { name, phones } = await contactPhones(contactId)
    for (const phone of phones) targets.push({ contactId, name, phone })
  }
  if (targets.length === 0) {
    logger.info({ leadId }, 'у контакта не указан телефон — искать не по чему')
    return null
  }

  const kinds = kind === undefined ? await preferredFirst(leadId, order) : [kind]
  // Мессенджер снаружи, телефон внутри: важнее попасть в нужный мессенджер,
  // чем перебрать все телефоны в первом попавшемся.
  for (const k of kinds) {
    for (const t of targets) {
      // Без добавления в контакты: агент пишет многим, а массовый поиск
      // по номерам мессенджеры считают рассылкой. Если человек закрыл
      // поиск по номеру, агент до него не достучится — и это правильно.
      const opened = await manager.openChatByPhone(k, t.phone, t.name)
      if (opened === null) continue

      await sql`
        update chats set amo_lead_id = ${leadId}, amo_contact_id = ${t.contactId}, updated_at = now()
        where id = ${opened.chat_id}::bigint
      `
      logger.info(
        { leadId, contactId: t.contactId, мессенджер: k, chatId: opened.chat_id },
        'переписки не было — завёл по телефону из карточки',
      )
      return {
        chat_id: opened.chat_id,
        channel_id: opened.channel_id,
        external_chat_id: opened.external_chat_id,
        phone: t.phone,
        channel_kind: k,
        last_message_at: null,
      }
    }
  }

  logger.info({ leadId, мессенджеры: kinds }, 'номер не нашёлся ни в одном мессенджере')
  return null
}

/**
 * Порядок обхода мессенджеров с учётом просьбы клиента.
 *
 * В калькуляторе на сайте есть вопрос «куда прислать расчёт». Если человек
 * ответил, начинаем оттуда: писать в другой мессенджер, когда он назвал
 * свой, — верный способ остаться непрочитанным. Остальные остаются
 * запасными: выбранного мессенджера у человека может и не оказаться.
 */
async function preferredFirst(leadId: number, order: ChannelKind[]): Promise<ChannelKind[]> {
  const preferred = await leadPreferredMessenger(leadId).catch((err: unknown) => {
    logger.warn({ err, leadId }, 'не смог прочитать выбранный клиентом мессенджер')
    return null
  })
  if (preferred === null) return order
  logger.info({ leadId, мессенджер: preferred }, 'клиент сам просил писать сюда')
  return [preferred, ...order.filter((k) => k !== preferred)]
}
