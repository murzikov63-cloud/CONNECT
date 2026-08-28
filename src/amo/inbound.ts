import { UnrecoverableError, Worker } from 'bullmq'
import type { Job } from 'bullmq'
import { alert } from '../alerts/index.js'
import { config } from '../config/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { QUEUE_INBOUND, connection } from '../queue/index.js'
import type { InboundJob } from '../queue/index.js'
import { getSettings } from '../settings.js'
import { mediaUrl } from '../wa/media.js'
import { channelForKind } from './channels.js'
import { AmoChatError, createChat, sendMessageToAmo, toAmoType } from './chat-client.js'
import type { AmoUser } from './chat-client.js'
import {
  createContact,
  createLead,
  findContactByPhone,
  findOpenLeadForContact,
  linkChatToContact,
} from './rest-client.js'

const logger = log('amo-inbound')

interface Row {
  message_id: string
  direction: string
  type: string
  body: string | null
  media_path: string | null
  media_name: string | null
  media_size: string | null
  occurred_at: Date
  sender_name: string | null
  chat_id: string
  external_chat_id: string
  chat_phone: string | null
  push_name: string | null
  avatar_url: string | null
  amo_chat_id: string | null
  amo_started_chat_id: string | null
  amo_conversation_key: string | null
  amo_contact_id: string | null
  amo_lead_id: string | null
  channel_kind: string
  channel_label: string
}

/** Ссылка на файл или аватар: у нас хранится либо адрес, либо путь на диске. */
function toPublicUrl(value: string | null): string | undefined {
  if (value === null || value === '') return undefined
  return value.startsWith('http') ? value : mediaUrl(value)
}

/**
 * Имя переписки в amoCRM должно быть постоянным: по нему amoCRM узнаёт,
 * что это та же самая беседа, а не новая.
 */
function conversationId(row: Row): string {
  // Обычно имя строится из номера переписки. Но если карточку, к которой
  // была привязана беседа, удалили, мы заводим беседу заново под другим
  // именем — и с этого момента пишем под ним.
  return row.amo_conversation_key ?? `${row.channel_kind}-${row.chat_id}`
}

/**
 * Отправитель для сообщений, которые менеджер написал прямо из мессенджера
 * на телефоне, минуя amoCRM.
 *
 * Выдуманного отправителя amoCRM не принимает: в беседе может быть только
 * один посторонний человек — клиент. Второй должен быть её собственным
 * пользователем, указанным ссылкой. Этот идентификатор amoCRM присылает
 * нам в каждом ответе менеджера, оттуда мы его и запоминаем.
 */
function buildBusinessUser(senderRefId: string): { ref_id: string } {
  return { ref_id: senderRefId }
}

/** Имя клиента как есть — им называется карточка контакта в amoCRM. */
function clientName(row: Row): string {
  const name = row.push_name ?? row.sender_name ?? ''
  return name === '' ? 'Без имени' : name
}

/**
 * Собеседник для amoCRM.
 *
 * Пометку мессенджера в имя добавлять бесполезно: если чат привязан
 * к контакту, amoCRM показывает имя из карточки, а наше игнорирует.
 * Проверено на живом аккаунте. Различать беседы разных мессенджеров
 * можно только отдельными каналами amoCRM.
 */
function buildSender(row: Row): AmoUser {
  const user: AmoUser = {
    id: `${row.channel_kind}-${row.external_chat_id}`,
    name: clientName(row),
  }
  const avatar = toPublicUrl(row.avatar_url)
  if (avatar !== undefined) user.avatar = avatar
  if (row.chat_phone !== null && row.chat_phone !== '') {
    user.profile = { phone: row.chat_phone }
  }
  return user
}

async function loadRow(messageId: string): Promise<Row | null> {
  const rows = await sql<Row[]>`
    select m.id::text            as message_id,
           m.direction, m.type, m.body, m.media_path, m.media_name,
           m.media_size::text    as media_size,
           m.occurred_at, m.sender_name,
           c.id::text            as chat_id,
           c.external_chat_id, c.phone as chat_phone, c.push_name, c.avatar_url,
           c.amo_chat_id, c.amo_started_chat_id, c.amo_conversation_key,
           c.amo_contact_id::text as amo_contact_id,
           c.amo_lead_id::text   as amo_lead_id,
           ch.kind               as channel_kind,
           ch.label              as channel_label
    from messages m
    join chats c on c.id = m.chat_id
    join channels ch on ch.id = m.channel_id
    where m.id = ${messageId}
  `
  return rows[0] ?? null
}

/** Заводит чат, контакт и сделку в amoCRM — по одному разу на переписку. */
async function ensureAmoEntities(row: Row): Promise<{ amoChatId: string }> {
  const amoChannel = channelForKind(row.channel_kind as never)
  let amoChatId = row.amo_chat_id

  if (amoChatId === null) {
    const created = await createChat(amoChannel, conversationId(row), buildSender(row))
    amoChatId = created.id
    await sql`update chats set amo_chat_id = ${amoChatId}, updated_at = now() where id = ${row.chat_id}`
    logger.info({ chatId: row.chat_id, amoChatId }, 'чат создан в amoCRM')
  }

  if (row.amo_contact_id === null) {
    const phone = row.chat_phone ?? ''
    // Дедупликация по телефону: если контакт уже есть — пишем в него,
    // а не плодим второй с тем же номером.
    const existing = phone === '' ? null : await findContactByPhone(phone)
    // В карточку контакта пишем чистое имя, без пометки мессенджера.
    const contact = existing ?? (await createContact(clientName(row), phone))

    await sql`
      update chats set amo_contact_id = ${contact.id}, updated_at = now() where id = ${row.chat_id}
    `
    await linkChatToContact(contact.id, amoChatId)
    row.amo_contact_id = String(contact.id)

    if (existing !== null) {
      logger.info({ contactId: contact.id, phone }, 'нашёлся существующий контакт')
    }
  }

  if (row.amo_lead_id === null) {
    const contactId = Number(row.amo_contact_id)
    const settings = await getSettings()
    const open = await findOpenLeadForContact(contactId)
    const lead =
      open ??
      (await createLead(
        `Обращение из ${row.channel_kind === 'telegram' ? 'Телеграма' : 'WhatsApp'}`,
        contactId,
        settings.amoPipelineId,
        settings.amoStatusId,
      ))
    await sql`
      update chats set amo_lead_id = ${lead.id}, updated_at = now() where id = ${row.chat_id}
    `
  }

  return { amoChatId }
}

/**
 * Отправка с одним отличием: отказ «не по формату» повторять бессмысленно.
 * Тем же телом мы получим тот же отказ пять раз подряд и задержим очередь,
 * в которой ждут живые сообщения.
 */
async function sendToAmo(
  ...args: Parameters<typeof sendMessageToAmo>
): Promise<Awaited<ReturnType<typeof sendMessageToAmo>>> {
  try {
    return await sendMessageToAmo(...args)
  } catch (err) {
    if (err instanceof AmoChatError && err.status === 400) throw new UnrecoverableError(err.message)
    throw err
  }
}

/**
 * Сообщить агенту продаж, что клиент ответил.
 *
 * Разговор не заканчивается первым сообщением: на каждый ответ клиента
 * агент готовит следующий черновик, а менеджер его одобряет. Ошибку
 * глотаем намеренно — переписка в карточке уже есть, и терять её из-за
 * недоступного n8n нельзя.
 */
async function позватьАгента(row: Row): Promise<void> {
  if (config.AGENT_DRAFT_WEBHOOK_URL === '') return
  if (row.amo_lead_id === null) return

  try {
    const res = await fetch(config.AGENT_DRAFT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: Number(row.amo_lead_id),
        event: 'client_reply',
        text: row.body ?? '',
        kind: row.channel_kind,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      logger.warn({ статус: res.status, leadId: row.amo_lead_id }, 'агент продаж не принял событие')
      return
    }
    logger.info({ leadId: row.amo_lead_id }, 'позвал агента продаж на ответ клиента')
  } catch (err: unknown) {
    logger.warn({ err, leadId: row.amo_lead_id }, 'не смог позвать агента продаж')
  }
}

export function createInboundWorker(): Worker<InboundJob> {
  const worker = new Worker<InboundJob>(
    QUEUE_INBOUND,
    async (job: Job<InboundJob>) => {
      const row = await loadRow(job.data.dbMessageId)
      if (row === null) {
        logger.warn({ messageId: job.data.dbMessageId }, 'сообщение исчезло, пропускаю')
        return
      }

      // Беседа, которую завела amoCRM, уже привязана к нужной карточке —
      // своих чат, контакт и сделку заводить не нужно и вредно: получится
      // второй контакт с тем же телефоном и лишняя сделка.
      const startedChatId = row.amo_started_chat_id
      if (startedChatId === null) await ensureAmoEntities(row)

      // Менеджер вполне может ответить прямо с телефона, минуя amoCRM.
      // Такие сообщения тоже должны быть в карточке, иначе там будет
      // половина разговора. Отличаются они парой «отправитель — получатель»:
      // для исходящих отправитель — мы, получатель — клиент.
      const isOutgoing = row.direction === 'out'
      const client = buildSender(row)
      const settings = await getSettings()
      const senderRefId = settings.amoSenderRefId

      // Пока менеджер ни разу не отвечал из amoCRM, подписать его сообщение
      // нечем. Показать его в карточке не выйдет, но и держать сообщение
      // в очереди бессмысленно: клиентские сообщения важнее, а это придёт
      // в следующий раз, когда идентификатор станет известен.
      if (isOutgoing && (senderRefId === null || senderRefId === '')) {
        logger.info(
          { messageId: row.message_id },
          'сообщение менеджера с телефона пропущено: amoCRM ещё не назвала отправителя',
        )
        return
      }

      const result = await sendToAmo(channelForKind(row.channel_kind as never), {
        conversationId: conversationId(row),
        ...(startedChatId === null ? {} : { conversationRefId: startedChatId }),
        msgid: `msg-${row.message_id}`,
        sender: isOutgoing ? buildBusinessUser(senderRefId as string) : client,
        ...(isOutgoing ? { receiver: client } : {}),
        // Своё же отправленное не должно дёргать менеджера уведомлением.
        silent: isOutgoing,
        type: toAmoType(row.type),
        text: row.body ?? '',
        ...(toPublicUrl(row.media_path) !== undefined
          ? { media: toPublicUrl(row.media_path) as string }
          : {}),
        ...(row.media_name !== null ? { fileName: row.media_name } : {}),
        ...(row.media_size !== null ? { fileSize: Number(row.media_size) } : {}),
        occurredAt: new Date(row.occurred_at),
      })

      await sql`
        update messages set amo_message_id = ${result.new_message.msgid}
        where id = ${row.message_id}
      `
      logger.info(
        { messageId: row.message_id, amoMessageId: result.new_message.msgid },
        'сообщение передано в amoCRM',
      )

      // Клиент ответил — значит разговор продолжается, и агенту продаж
      // есть что предложить менеджеру. Своё же отправленное сюда не
      // считается: на собственную реплику отвечать нечего.
      if (!isOutgoing) await позватьАгента(row)
    },
    { connection, concurrency: 3 },
  )

  worker.on('failed', (job, err) => {
    if (job === undefined) return
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1)
    if (!exhausted) {
      logger.warn({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, 'повторю позже')
      return
    }
    void alert('error', 'Сообщение не дошло до amoCRM', {
      Причина: err.message,
      Действие: 'переписка в мессенджере есть, в карточке — нет',
    })
  })

  return worker
}
