import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import type { ChannelKind } from '../channels/types.js'
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
