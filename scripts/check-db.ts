/**
 * Прогоняет миграции на живой базе и проверяет ключевые гарантии схемы:
 * дедупликацию сообщений и суточный счётчик новых чатов.
 * Запускать на пустой тестовой базе:  npx tsx scripts/check-db.ts
 */
import { closeDb, migrate, sql } from '../src/db/index.js'

/* eslint-disable no-console */

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++
  console.log(`${ok ? '  OK ' : 'СБОЙ '} ${name}${extra === '' ? '' : ` — ${extra}`}`)
}

await migrate()

const tables = await sql<{ table_name: string }[]>`
  select table_name from information_schema.tables where table_schema = 'public' order by table_name
`
const names = tables.map((t) => t.table_name)
for (const t of ['channels', 'channel_auth_state', 'chats', 'messages', 'outbound_daily', 'settings']) {
  check(`таблица ${t}`, names.includes(t))
}

// Проверяем не только наличие таблиц, но и колонок, в которые пишет код.
// Переименование колонки миграцией легко пропустить в одном из запросов —
// и тогда падать будет уже на живых данных.
const EXPECTED: Record<string, string[]> = {
  channels: [
    'id', 'kind', 'label', 'phone', 'external_id', 'status',
    'last_qr', 'last_qr_at', 'last_connected_at', 'last_disconnect_reason', 'deleted_at',
  ],
  channel_auth_state: ['channel_id', 'key', 'value'],
  chats: [
    'id', 'channel_id', 'external_chat_id', 'phone', 'push_name', 'avatar_url',
    'is_group', 'ignored', 'amo_chat_id', 'amo_contact_id', 'amo_lead_id',
    'first_outbound_at', 'last_message_at',
  ],
  messages: [
    'id', 'channel_id', 'chat_id', 'external_message_id', 'amo_message_id',
    'direction', 'type', 'body', 'media_path', 'media_mime', 'media_name', 'media_size',
    'quoted_external_message_id', 'sender_name', 'status', 'error',
    'sent_at', 'delivered_at', 'read_at', 'occurred_at',
  ],
  outbound_daily: ['channel_id', 'day', 'new_chats'],
  settings: ['key', 'value'],
}

for (const [table, columns] of Object.entries(EXPECTED)) {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `
  const present = new Set(rows.map((r) => r.column_name))
  const missing = columns.filter((c) => !present.has(c))
  check(`колонки ${table}`, missing.length === 0, missing.length === 0 ? '' : `нет: ${missing.join(', ')}`)
}

const [num] = await sql<{ id: string }[]>`
  insert into channels (kind, label) values ('whatsapp', 'тестовый') returning id
`
const channelId = num!.id
const [chat] = await sql<{ id: string }[]>`
  insert into chats (channel_id, external_chat_id, phone) values (${channelId}, '79991234567@s.whatsapp.net', '79991234567')
  returning id
`

const insertMsg = () => sql<{ id: string }[]>`
  insert into messages (channel_id, chat_id, external_message_id, direction, type, body, occurred_at)
  values (${channelId}, ${chat!.id}, 'WAMSG1', 'in', 'text', 'привет', now())
  on conflict do nothing returning id
`
const first = await insertMsg()
const second = await insertMsg()
check('первое сообщение сохраняется', first.length === 1)
check('повтор того же id отбрасывается', second.length === 0)

// Одинаковый id в разных направлениях — разные сообщения (эхо своей же отправки).
const echo = await sql<{ id: string }[]>`
  insert into messages (channel_id, chat_id, external_message_id, direction, type, body, occurred_at)
  values (${channelId}, ${chat!.id}, 'WAMSG1', 'out', 'text', 'ответ', now())
  on conflict do nothing returning id
`
check('входящее и исходящее с одним id не конфликтуют', echo.length === 1)

const bump = () => sql<{ new_chats: number }[]>`
  insert into outbound_daily (channel_id, day, new_chats) values (${channelId}, current_date, 1)
  on conflict (channel_id, day) do update set new_chats = outbound_daily.new_chats + 1
  returning new_chats
`
await bump()
const [twice] = await bump()
check('суточный счётчик новых чатов растёт', twice?.new_chats === 2, String(twice?.new_chats))

// Тот самый запрос, которым менеджер записывает состояние канала.
// Он ломался молча, когда колонку переименовали, а запрос забыли.
try {
  await sql`
    update channels set
      status = 'online',
      phone = coalesce(${'79990000000'}, phone),
      external_id = coalesce(${'79990000000@s.whatsapp.net'}, external_id),
      last_connected_at = now(),
      last_qr = null,
      last_disconnect_reason = null,
      updated_at = now()
    where id = ${channelId}
  `
  check('запись состояния канала проходит', true)
} catch (err) {
  check('запись состояния канала проходит', false, err instanceof Error ? err.message : '')
}

// Миграции идемпотентны — повторный запуск не должен ничего ломать.
await migrate()
check('повторный прогон миграций безопасен', true)

await sql`delete from channels where id = ${channelId}`
const left = await sql<{ n: string }[]>`select count(*)::text as n from messages`
check('удаление номера уносит его сообщения', left[0]?.n === '0')

await closeDb()
console.log(failed === 0 ? '\nСхема в порядке.' : `\nПроблем: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
