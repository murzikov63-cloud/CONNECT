import { Worker } from 'bullmq'
import type { Job } from 'bullmq'
import { alert } from '../alerts/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { getSettings } from '../settings.js'
import { randomDelay, sleep } from '../utils.js'
import type { SessionManager } from '../wa/manager.js'
import { QUEUE_OUTBOUND, connection } from './index.js'
import type { OutboundJob } from './index.js'

const logger = log('outbound')

/** Ошибка, при которой ретраить бессмысленно — сразу помечаем провал. */
class PermanentError extends Error {}

/**
 * Счётчик новых чатов на номер в сутки. Первое сообщение незнакомому
 * контакту — самый заметный для WhatsApp признак рассылки, поэтому
 * лимитируем именно его (раздел 5 ТЗ).
 */
async function reserveNewChatSlot(numberId: string, limit: number): Promise<boolean> {
  const rows = await sql<{ new_chats: number }[]>`
    insert into outbound_daily (number_id, day, new_chats)
    values (${numberId}, current_date, 1)
    on conflict (number_id, day) do update set new_chats = outbound_daily.new_chats + 1
    returning new_chats
  `
  const used = rows[0]?.new_chats ?? 0
  if (used <= limit) return true

  await sql`
    update outbound_daily set new_chats = new_chats - 1
    where number_id = ${numberId} and day = current_date
  `
  return false
}

export function createOutboundWorker(manager: SessionManager): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_OUTBOUND,
    async (job: Job<OutboundJob>) => {
      const out = job.data
      const settings = await getSettings()

      const session = manager.getSession(out.numberId)
      if (session === undefined || session.socket === null) {
        // Номер поднимется сам — пусть очередь подождёт и попробует снова.
        throw new Error(`сессия номера ${out.numberId} сейчас не в сети`)
      }

      const chats = await sql<{ id: string; first_outbound_at: Date | null }[]>`
        select id, first_outbound_at from chats
        where number_id = ${out.numberId} and chat_jid = ${out.chatJid}
      `
      const chat = chats[0]
      const isNewChat = chat === undefined || chat.first_outbound_at === null

      if (isNewChat) {
        const allowed = await reserveNewChatSlot(
          out.numberId,
          settings.newChatsPerNumberPerDay,
        )
        if (!allowed) {
          throw new PermanentError(
            `дневной лимит новых чатов исчерпан (${settings.newChatsPerNumberPerDay})`,
          )
        }
      }

      // Длинная пауза оправдана только для первого сообщения незнакомцу.
      // В живой переписке она бы съела весь бюджет в 5 секунд.
      const [minMs, maxMs] = isNewChat
        ? [settings.newChatDelayMinMs, settings.newChatDelayMaxMs]
        : [settings.replyDelayMinMs, settings.replyDelayMaxMs]
      await sleep(randomDelay(minMs, maxMs))

      const waMessageId = await session.send(out)

      await sql`
        update messages set
          wa_message_id = ${waMessageId}, status = 'sent', sent_at = now(), error = null
        where id = ${out.dbMessageId}
      `
      if (chat !== undefined && isNewChat) {
        await sql`
          update chats set first_outbound_at = now() where id = ${chat.id}
        `
      }

      logger.info({ numberId: out.numberId, waMessageId }, 'исходящее отправлено')
      return { waMessageId }
    },
    {
      connection,
      // По одному сообщению на номер за раз — параллельная отправка с одного
      // номера выглядит как бот. Разные номера идут независимо.
      concurrency: 4,
      limiter: { max: 1, duration: 1_000 },
    },
  )

  worker.on('failed', (job, err) => {
    if (job === undefined) return
    const permanent = err instanceof PermanentError
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1)
    if (!permanent && !exhausted) {
      logger.warn({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, 'повторю позже')
      return
    }

    void (async () => {
      await sql`
        update messages set status = 'failed', error = ${err.message}
        where id = ${job.data.dbMessageId}
      `
      await alert('error', 'Сообщение не ушло в WhatsApp', {
        Номер: job.data.numberId,
        Чат: job.data.chatJid,
        Причина: err.message,
      })
    })().catch((e: unknown) => logger.error({ err: e }, 'не смог пометить провал отправки'))
  })

  return worker
}
