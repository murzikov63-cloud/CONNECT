/**
 * Ставит в очередь входящие, которые ещё не доехали до amoCRM.
 *
 *   npx tsx scripts/resend-to-amo.ts          # показать, сколько таких
 *   npx tsx scripts/resend-to-amo.ts --do     # поставить в очередь
 *
 * Нужен после простоя связи с amoCRM и при разборе аварий.
 */
import { closeDb, sql } from '../src/db/index.js'
import { closeQueues, inboundQueue } from '../src/queue/index.js'

/* eslint-disable no-console */

const apply = process.argv.includes('--do')

const rows = await sql<{ id: string; channel_id: string; chat_id: string }[]>`
  select m.id::text, m.channel_id::text as channel_id, m.chat_id::text as chat_id
  from messages m
  where m.direction = 'in' and m.amo_message_id is null
  order by m.id
`

console.log(`Не доехало до amoCRM: ${rows.length}`)

if (!apply) {
  console.log('Запустите с --do, чтобы поставить их в очередь.')
} else {
  for (const r of rows) {
    await inboundQueue.add(
      'to-amo',
      { dbMessageId: r.id, channelId: r.channel_id, chatId: r.chat_id },
      { jobId: `in-${r.id}` },
    )
  }
  console.log(`Поставлено в очередь: ${rows.length}`)
}

await closeQueues()
await closeDb()
