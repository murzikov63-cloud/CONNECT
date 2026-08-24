import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import type { MessageType } from '../types.js'

const logger = log('amo-webhook')

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Виды тела, от которых может быть посчитана подпись.
 *
 * amoCRM подписывает не то тело, которое присылает: подпись считается
 * от JSON в экранированном виде — русские буквы записаны как \uXXXX,
 * косые черты как \/, — а приходит к нам обычный текст. Пока в переписке
 * одна латиница, два вида совпадают и всё сходится; первое же русское
 * слово всё ломает. Выяснено на 104 живых запросах.
 *
 * Поэтому пробуем три вида: как пришло, и две пересборки — с косыми
 * чертами и без. Лишние два расчёта стоят микросекунды.
 */
function signedForms(rawBody: string): string[] {
  const forms = [rawBody]
  try {
    const canonical = JSON.stringify(JSON.parse(rawBody))
    forms.push(canonical.replace(/\//g, '\\/'), canonical)
  } catch {
    // Не JSON — сравнить можно только с тем, что пришло.
  }
  return forms
}

/** Совпадают ли подписи. Сравниваем за постоянное время, а не по первому байту. */
function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Подпись вебхука: HMAC-SHA1 от тела на секрете своего канала. */
export function verifyWebhookSignature(
  secretKey: string,
  rawBody: string,
  signature: string,
): boolean {
  if (secretKey === '' || signature === '') return false
  const given = signature.toLowerCase()
  return signedForms(rawBody).some((form) =>
    sameSignature(createHmac('sha1', secretKey).update(form).digest('hex'), given),
  )
}

/**
 * Можно ли вообще судить о подлинности этого запроса.
 *
 * Если тело не разбирается как JSON, вид, от которого считалась подпись,
 * нам неизвестен — и несовпадение ещё не означает подделку. Отвергать
 * такое нельзя: потеряется ответ менеджера клиенту.
 */
export function signatureIsDecidable(rawBody: string): boolean {
  try {
    JSON.parse(rawBody)
    return true
  } catch {
    return false
  }
}

/**
 * Разбор несошедшейся подписи. Пишет только длины и контрольные суммы,
 * без содержимого сообщения. Нужен ровно один раз — чтобы понять, над чем
 * именно amoCRM считает подпись.
 */
export function describeSignatureMismatch(
  channel: { secretKey: string; scopeId: string },
  rawBody: string,
  signature: string,
  headers: Record<string, unknown>,
): Record<string, unknown> {
  const secret = channel.secretKey
  const md5 = createHash('md5').update(rawBody).digest('hex')
  const variants: Record<string, string> = {
    'hmac-sha1(тело)': createHmac('sha1', secret).update(rawBody).digest('hex'),
    'hmac-sha1(md5 тела)': createHmac('sha1', secret).update(md5).digest('hex'),
    'hmac-sha1(md5 в байтах)': createHmac('sha1', secret)
      .update(Buffer.from(md5, 'hex'))
      .digest('hex'),
    'hmac-sha1(тело), ключ hex': createHmac('sha1', Buffer.from(secret, 'hex'))
      .update(rawBody)
      .digest('hex'),
    'sha1(секрет+тело)': createHash('sha1').update(`${secret}${rawBody}`).digest('hex'),
    'sha1(тело+секрет)': createHash('sha1').update(`${rawBody}${secret}`).digest('hex'),
    'hmac-sha1(тело+дата)': createHmac('sha1', secret)
      .update(`${rawBody}${String(headers['date'] ?? '')}`)
      .digest('hex'),
    'hmac-sha1(scope+тело)': createHmac('sha1', secret)
      .update(`${channel.scopeId}${rawBody}`)
      .digest('hex'),
  }
  const matched = Object.entries(variants).find(([, v]) => v === signature.toLowerCase())

  return {
    получено: signature,
    длинаТела: rawBody.length,
    телоПолучено: rawBody !== '',
    contentLength: headers['content-length'],
    совпалВариант: matched?.[0] ?? 'ни один',
    варианты: variants,
  }
}

/** Типы amoCRM -> наши. */
export function fromAmoType(type: string | undefined): MessageType {
  switch (type) {
    case 'picture':
      return 'image'
    case 'file':
      return 'document'
    case 'video':
      return 'video'
    case 'voice':
      return 'voice'
    case 'audio':
      return 'audio'
    case 'sticker':
      return 'sticker'
    case 'location':
      return 'location'
    case 'contact':
      return 'contact'
    default:
      return 'text'
  }
}

export interface OutgoingFromAmo {
  /** Наш идентификатор переписки, который мы сами и отдавали amoCRM. */
  conversationClientId: string
  /** Идентификатор чата на стороне amoCRM. */
  amoChatId: string
  amoMessageId: string
  /**
   * Телефон получателя. Единственная зацепка, когда менеджер начал разговор
   * сам: amoCRM заводит беседу с новым идентификатором, которого мы ещё
   * не видели, и связать её с нашей перепиской больше не по чему.
   */
  receiverPhone: string
  receiverName: string
  /** Пользователь amoCRM, от чьего имени пришёл ответ. */
  senderRefId: string
  type: MessageType
  text: string
  media?: string
  fileName?: string
  fileSize?: number
}

/**
 * Разбор вебхука.
 *
 * Формат исходящих в документации amoCRM описан скупо, а на практике поля
 * приходят вложенными. Поэтому проверяем несколько вариантов расположения:
 * лучше принять сообщение, чем потерять ответ менеджера клиенту.
 */
export function parseOutgoing(body: any): OutgoingFromAmo | null {
  const m = body?.message ?? body
  const conversation = m?.conversation ?? {}
  const inner = m?.message ?? m

  const conversationClientId: string =
    conversation.client_id ?? conversation.conversation_id ?? m?.conversation_id ?? ''
  const amoChatId: string = conversation.id ?? m?.chat_id ?? ''
  const amoMessageId: string = inner?.id ?? m?.msgid ?? ''

  if (conversationClientId === '' && amoChatId === '') return null

  const receiver = m?.receiver ?? {}
  const result: OutgoingFromAmo = {
    conversationClientId,
    amoChatId,
    amoMessageId,
    receiverPhone: String(receiver.phone ?? '').replace(/\D/g, ''),
    receiverName: String(receiver.name ?? ''),
    senderRefId: String(m?.sender?.id ?? ''),
    type: fromAmoType(inner?.type),
    text: inner?.text ?? '',
  }
  if (typeof inner?.media === 'string' && inner.media !== '') result.media = inner.media
  if (typeof inner?.file_name === 'string') result.fileName = inner.file_name
  if (typeof inner?.file_size === 'number') result.fileSize = inner.file_size
  return result
}

export interface ResolvedChat {
  chat_id: string
  channel_id: string
  external_chat_id: string
  amo_chat_id: string | null
}

/**
 * Забывает беседу, которую когда-то завела amoCRM.
 *
 * Менеджер написал через нашу беседу — значит в карточке он видит именно
 * её, и ответ клиента должен лечь туда же. Прежняя беседа amoCRM может
 * быть уже мертва: карточку, в которой она жила, удалили, и сообщения
 * в неё уходят в никуда — amoCRM их принимает и нигде не показывает.
 * Поэтому побеждает та беседа, которой менеджер пользовался последней.
 */
async function forgetStartedChat(chatId: string): Promise<void> {
  const changed = await sql<{ id: string }[]>`
    update chats set amo_started_chat_id = null, updated_at = now()
    where id = ${chatId} and amo_started_chat_id is not null
    returning id::text as id
  `
  if (changed[0] !== undefined) {
    logger.info({ chatId }, 'менеджер вернулся в нашу беседу, прежнюю забываю')
  }
}

/**
 * Находит нашу переписку по тому, что прислал amoCRM.
 * Порядок важен: сначала точные совпадения, телефон — последняя попытка.
 */
export async function resolveChat(
  parsed: OutgoingFromAmo,
  kind: string,
): Promise<ResolvedChat | null> {
  // Сначала по идентификатору чата amoCRM. Их у переписки может быть два:
  // наш, заведённый на первое входящее, и тот, что amoCRM завела сама,
  // когда менеджер написал первым.
  if (parsed.amoChatId !== '') {
    const rows = await sql<ResolvedChat[]>`
      select id::text as chat_id, channel_id::text as channel_id, external_chat_id, amo_chat_id
      from chats
      where amo_chat_id = ${parsed.amoChatId} or amo_started_chat_id = ${parsed.amoChatId}
    `
    const found = rows[0]
    if (found !== undefined) {
      if (found.amo_chat_id === parsed.amoChatId) await forgetStartedChat(found.chat_id)
      return found
    }
  }

  // Запасной путь: наш собственный идентификатор вида «telegram-<id чата>».
  const match = /^[a-z]+-(\d+)$/.exec(parsed.conversationClientId)
  if (match !== null) {
    const rows = await sql<ResolvedChat[]>`
      select id::text as chat_id, channel_id::text as channel_id, external_chat_id, amo_chat_id
      from chats where id = ${match[1]!}
    `
    const found = rows[0]
    if (found !== undefined) {
      await forgetStartedChat(found.chat_id)
      return found
    }
  }

  // Менеджер начал разговор сам: беседа новая, но телефон получателя
  // amoCRM присылает. Ищем переписку с этим телефоном в том мессенджере,
  // канал которого выбрал менеджер.
  if (parsed.receiverPhone !== '') {
    const rows = await sql<ResolvedChat[]>`
      select c.id::text as chat_id, c.channel_id::text as channel_id, c.external_chat_id,
             c.amo_chat_id
      from chats c
      join channels ch on ch.id = c.channel_id
      where ch.kind = ${kind} and ch.deleted_at is null
        and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = ${parsed.receiverPhone}
      order by c.last_message_at desc nulls last
      limit 1
    `
    const found = rows[0]
    if (found !== undefined) {
      // Беседу amoCRM запоминаем отдельно, не подменяя свою.
      //
      // Менеджер пишет из карточки, где переписки ещё не было, — amoCRM
      // заводит свою беседу и показывает её в этой самой карточке. Ответ
      // клиента придёт к нам, и если положить его в нашу беседу, он
      // окажется в другой карточке: в той, что amoCRM когда-то завела
      // на входящее. Разговор разъедется надвое, а под ответ появится
      // вторая сделка. Поэтому дальше пишем в беседу карточки.
      //
      // Подменять этим свой идентификатор нельзя: по нему мы узнаём
      // переписку в других местах.
      if (parsed.amoChatId !== '' && parsed.amoChatId !== found.amo_chat_id) {
        await sql`
          update chats set amo_started_chat_id = ${parsed.amoChatId}, updated_at = now()
          where id = ${found.chat_id}
        `
        logger.info(
          { chatId: found.chat_id, amoChatId: parsed.amoChatId },
          'запомнил беседу, которую завела amoCRM',
        )
      }
      logger.info(
        { phone: parsed.receiverPhone, kind },
        'переписка найдена по телефону получателя',
      )
      return found
    }
  }

  // Не тревога: следом попробуем найти человека по телефону и завести
  // переписку. Тревожиться будем, если и это не выйдет.
  logger.info(
    {
      amoChatId: parsed.amoChatId,
      conversationClientId: parsed.conversationClientId,
      телефонПолучателя: parsed.receiverPhone === '' ? 'нет' : 'есть',
      мессенджер: kind,
    },
    'готовой переписки нет',
  )
  return null
}
