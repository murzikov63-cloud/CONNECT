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

async function readData<T>(numberId: string, key: string): Promise<T | null> {
  const rows = await sql<{ value: unknown }[]>`
    select value from wa_auth_state where number_id = ${numberId} and key = ${key}
  `
  const row = rows[0]
  if (row === undefined) return null
  return decode<T>(row.value)
}

async function writeData(numberId: string, key: string, value: unknown): Promise<void> {
  await sql`
    insert into wa_auth_state (number_id, key, value, updated_at)
    values (${numberId}, ${key}, ${sql.json(encode(value) as never)}, now())
    on conflict (number_id, key)
    do update set value = excluded.value, updated_at = now()
  `
}

async function removeData(numberId: string, key: string): Promise<void> {
  await sql`delete from wa_auth_state where number_id = ${numberId} and key = ${key}`
}

export async function clearAuthState(numberId: string): Promise<void> {
  await sql`delete from wa_auth_state where number_id = ${numberId}`
}

export interface PgAuthState {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

export async function usePostgresAuthState(numberId: string): Promise<PgAuthState> {
  const creds =
    (await readData<AuthenticationCreds>(numberId, 'creds')) ?? (initAuthCreds() as AuthenticationCreds)

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const result: Record<string, unknown> = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData<unknown>(numberId, `${type}-${id}`)
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
                  ? writeData(numberId, key, value)
                  : removeData(numberId, key),
              )
            }
          }
          await Promise.all(tasks)
        },
      },
    } as unknown as AuthenticationState,
    saveCreds: () => writeData(numberId, 'creds', creds),
  }
}
