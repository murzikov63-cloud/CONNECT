import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../config/index.js'
import type { OutboundMessage } from '../types.js'

// BullMQ требует отключённый лимит ретраев у соединения, иначе воркеры
// падают при первом же моргании Redis.
export const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null })

export interface OutboundJob extends OutboundMessage {
  /** id строки в messages — по ней проставляем статус после отправки. */
  dbMessageId: string
}

export interface InboundJob {
  dbMessageId: string
  channelId: string
  chatId: string
}

export const QUEUE_OUTBOUND = 'outbound'
export const QUEUE_INBOUND = 'inbound'

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
}

export const outboundQueue = new Queue<OutboundJob>(QUEUE_OUTBOUND, {
  connection,
  defaultJobOptions,
})

export const inboundQueue = new Queue<InboundJob>(QUEUE_INBOUND, {
  connection,
  defaultJobOptions,
})

export async function closeQueues(): Promise<void> {
  await outboundQueue.close()
  await inboundQueue.close()
  connection.disconnect()
}
