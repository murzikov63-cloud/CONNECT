import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import type { ChannelKind } from '../channels/types.js'
import type { DeliveryStatus } from '../types.js'
import { channelForKind } from './channels.js'
import { DELIVERY, setDeliveryStatus } from './chat-client.js'

const logger = log('amo-delivery')

/**
 * Сообщает amoCRM, что ответ менеджера не дошёл.
 *
 * Без этого amoCRM показывает «Отправлено» независимо от того, что
 * случилось на самом деле: менеджер уверен, что клиент прочтёт, а
 * сообщение никуда не ушло. Молчаливая потеря хуже видимой ошибки.
 */
export async function reportUndelivered(
  kind: ChannelKind,
  amoMessageId: string,
  reason: string,
): Promise<void> {
  if (amoMessageId === '') return
  try {
    await setDeliveryStatus(channelForKind(kind), amoMessageId, DELIVERY.failed, reason)
    logger.info({ kind, amoMessageId, reason }, 'amoCRM уведомлена о недоставке')
  } catch (err) {
    logger.error({ err, amoMessageId }, 'не удалось сообщить amoCRM о недоставке')
  }
}

/**
 * Сообщает amoCRM, что сообщение дошло до собеседника или прочитано.
 *
 * Без этого в карточке навсегда остаётся «Отправлено», и менеджер не знает,
 * получил ли клиент сообщение вообще. В привычном сервисе на этом месте
 * были две галочки — сделаем так же.
 */
export async function reportDelivery(
  channelId: string,
  externalMessageId: string,
  status: DeliveryStatus,
): Promise<void> {
  const code = status === 'read' ? DELIVERY.read : status === 'delivered' ? DELIVERY.delivered : null
  if (code === null) return

  const rows = await sql<{ kind: ChannelKind; amo_message_id: string | null }[]>`
    select ch.kind, m.amo_message_id
    from messages m join channels ch on ch.id = m.channel_id
    where m.channel_id = ${channelId}
      and m.external_message_id = ${externalMessageId}
      and m.direction = 'out'
    limit 1
  `
  const row = rows[0]
  // Сообщения, которых amoCRM не знает (например, отправленных до её
  // подключения), помечать нечем — молча пропускаем.
  if (row?.amo_message_id == null || row.amo_message_id === '') return

  try {
    await setDeliveryStatus(channelForKind(row.kind), row.amo_message_id, code)
    logger.info({ kind: row.kind, status }, 'amoCRM уведомлена о доставке')
  } catch (err) {
    // Не беда: сообщение доставлено, а отметка о нём — украшение.
    logger.warn({ err, amoMessageId: row.amo_message_id, status }, 'не удалось отметить доставку')
  }
}

/** То же, но канал определяется по записи сообщения в базе. */
export async function reportUndeliveredByMessage(
  dbMessageId: string,
  reason: string,
): Promise<void> {
  const rows = await sql<{ kind: ChannelKind; amo_message_id: string | null }[]>`
    select ch.kind, m.amo_message_id
    from messages m join channels ch on ch.id = m.channel_id
    where m.id = ${dbMessageId}
  `
  const row = rows[0]
  if (row?.amo_message_id == null) return
  await reportUndelivered(row.kind, row.amo_message_id, reason)
}
