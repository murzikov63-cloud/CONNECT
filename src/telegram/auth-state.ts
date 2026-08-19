import { sql } from '../db/index.js'

/**
 * Состояние входа в Телеграм.
 *
 * `session` — длинная строка, которой библиотека доказывает Телеграму, что мы
 * это мы. Она равносильна паролю от аккаунта, поэтому лежит только в базе
 * и попадает в ежедневный бэкап вместе с ней.
 *
 * `pending` — временные данные между «отправили код» и «ввели код».
 */

interface Pending {
  phone: string
  phoneCodeHash: string
  session: string
}

async function read<T>(channelId: string, key: string): Promise<T | null> {
  const rows = await sql<{ value: T }[]>`
    select value from channel_auth_state where channel_id = ${channelId} and key = ${key}
  `
  return rows[0]?.value ?? null
}

async function write(channelId: string, key: string, value: unknown): Promise<void> {
  await sql`
    insert into channel_auth_state (channel_id, key, value, updated_at)
    values (${channelId}, ${key}, ${sql.json(value as never)}, now())
    on conflict (channel_id, key)
    do update set value = excluded.value, updated_at = now()
  `
}

export async function loadSession(channelId: string): Promise<string> {
  return (await read<string>(channelId, 'session')) ?? ''
}

export async function saveSession(channelId: string, session: string): Promise<void> {
  await write(channelId, 'session', session)
  await sql`delete from channel_auth_state where channel_id = ${channelId} and key = 'pending'`
}

export async function savePending(channelId: string, pending: Pending): Promise<void> {
  await write(channelId, 'pending', pending)
}

export async function loadPending(channelId: string): Promise<Pending | null> {
  return read<Pending>(channelId, 'pending')
}
