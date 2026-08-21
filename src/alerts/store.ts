import { sql } from '../db/index.js'
import type { CooldownStore } from './index.js'

const KEY = 'alert_cooldowns'

/**
 * Отметки о последних алертах в общей таблице настроек.
 *
 * Отдельной таблицы они не заслуживают: это несколько строк, которые
 * должны просто пережить перезапуск.
 */
export function dbCooldownStore(): CooldownStore {
  let cache: Record<string, number> | null = null

  async function load(): Promise<Record<string, number>> {
    if (cache !== null) return cache
    const rows = await sql<{ value: Record<string, number> }[]>`
      select value from settings where key = ${KEY}
    `
    cache = rows[0]?.value ?? {}
    return cache
  }

  return {
    async get(key) {
      return (await load())[key]
    },
    async set(key, at) {
      const all = await load()
      all[key] = at
      // Старьё выкидываем: без этого запись растёт от каждой новой беды.
      const месяцНазад = at - 30 * 24 * 60 * 60 * 1000
      for (const [k, v] of Object.entries(all)) if (v < месяцНазад) delete all[k]
      await sql`
        insert into settings (key, value, updated_at)
        values (${KEY}, ${sql.json(all as never)}, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `
    },
  }
}
