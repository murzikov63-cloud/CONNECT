import { sql } from '../db/index.js'
import { BufferJSON, initAuthCreds, proto } from './baileys.js'
import type { AuthenticationCreds, AuthenticationState } from './baileys.js'

/**
 * Хранилище ключей сессии Baileys в Postgres (п. 2.1 ТЗ).
 * Благодаря этому перезапуск сервиса не требует пересканирования QR,
 * а ежедневный дамп базы автоматически бэкапит и auth-state.
 */

// Buffer'ы внутри ключей не переживают обычный JSON — Baileys даёт для этого
// свои replacer/reviver, прогоняем значения через них в обе стороны.
function encode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as unknown
}

function decode<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

async function readData<T>(channelId: string, key: string): Promise<T | null> {
  const rows = await sql<{ value: unknown }[]>`
    select value from channel_auth_state where channel_id = ${channelId} and key = ${key}
  `
  const row = rows[0]
  if (row === undefined) return null
  return decode<T>(row.value)
}

async function writeData(channelId: string, key: string, value: unknown): Promise<void> {
  await sql`
    insert into channel_auth_state (channel_id, key, value, updated_at)
    values (${channelId}, ${key}, ${sql.json(encode(value) as never)}, now())
    on conflict (channel_id, key)
    do update set value = excluded.value, updated_at = now()
  `
}

async function removeData(channelId: string, key: string): Promise<void> {
  await sql`delete from channel_auth_state where channel_id = ${channelId} and key = ${key}`
}

export async function clearAuthState(channelId: string): Promise<void> {
  await sql`delete from channel_auth_state where channel_id = ${channelId}`
}

export interface PgAuthState {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

export async function usePostgresAuthState(channelId: string): Promise<PgAuthState> {
  const creds =
    (await readData<AuthenticationCreds>(channelId, 'creds')) ?? (initAuthCreds() as AuthenticationCreds)

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const result: Record<string, unknown> = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData<unknown>(channelId, `${type}-${id}`)
              if (type === 'app-state-sync-key' && value !== null) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              if (value !== null) result[id] = value
            }),
          )
          return result
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<void>[] = []
          for (const category of Object.keys(data)) {
            const bucket = data[category]
            if (bucket === undefined) continue
            for (const id of Object.keys(bucket)) {
              const value = bucket[id]
              const key = `${category}-${id}`
              tasks.push(
                value !== null && value !== undefined
                  ? writeData(channelId, key, value)
                  : removeData(channelId, key),
              )
            }
          }
          await Promise.all(tasks)
        },
      },
    } as unknown as AuthenticationState,
    saveCreds: () => writeData(channelId, 'creds', creds),
  }
}
