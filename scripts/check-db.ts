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
for (const t of ['wa_numbers', 'wa_auth_state', 'chats', 'messages', 'outbound_daily', 'settings']) {
  check(`таблица ${t}`, names.includes(t))
}

const [num] = await sql<{ id: string }[]>`
  insert into wa_numbers (label) values ('тестовый') returning id
`
const numberId = num!.id
const [chat] = await sql<{ id: string }[]>`
  insert into chats (number_id, chat_jid, phone) values (${numberId}, '79991234567@s.whatsapp.net', '79991234567')
  returning id
`

const insertMsg = () => sql<{ id: string }[]>`
  insert into messages (number_id, chat_id, wa_message_id, direction, type, body, occurred_at)
  values (${numberId}, ${chat!.id}, 'WAMSG1', 'in', 'text', 'привет', now())
  on conflict do nothing returning id
`
const first = await insertMsg()
const second = await insertMsg()
check('первое сообщение сохраняется', first.length === 1)
check('повтор того же id отбрасывается', second.length === 0)

// Одинаковый id в разных направлениях — разные сообщения (эхо своей же отправки).
const echo = await sql<{ id: string }[]>`
  insert into messages (number_id, chat_id, wa_message_id, direction, type, body, occurred_at)
  values (${numberId}, ${chat!.id}, 'WAMSG1', 'out', 'text', 'ответ', now())
  on conflict do nothing returning id
`
check('входящее и исходящее с одним id не конфликтуют', echo.length === 1)

const bump = () => sql<{ new_chats: number }[]>`
  insert into outbound_daily (number_id, day, new_chats) values (${numberId}, current_date, 1)
  on conflict (number_id, day) do update set new_chats = outbound_daily.new_chats + 1
  returning new_chats
`
await bump()
const [twice] = await bump()
check('суточный счётчик новых чатов растёт', twice?.new_chats === 2, String(twice?.new_chats))

// Миграции идемпотентны — повторный запуск не должен ничего ломать.
await migrate()
check('повторный прогон миграций безопасен', true)

await sql`delete from wa_numbers where id = ${numberId}`
const left = await sql<{ n: string }[]>`select count(*)::text as n from messages`
check('удаление номера уносит его сообщения', left[0]?.n === '0')

await closeDb()
console.log(failed === 0 ? '\nСхема в порядке.' : `\nПроблем: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
