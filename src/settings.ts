import { config } from './config/index.js'
import { sql } from './db/index.js'

/** Настройки, которые Анатолий меняет из админки без правки кода. */
export interface Settings {
  /** «Личные» номера — переписку с ними в amoCRM не отдаём. */
  personalNumbers: string[]
  ignoreGroups: boolean
  newChatsPerNumberPerDay: number
  sendDelayMinMs: number
  sendDelayMaxMs: number
  /** Воронка и этап для новых лидов; null — «Неразобранное». */
  amoPipelineId: number | null
  amoStatusId: number | null
}

const DEFAULTS = (): Settings => ({
  personalNumbers: [],
  ignoreGroups: config.IGNORE_GROUPS,
  newChatsPerNumberPerDay: config.NEW_CHATS_PER_NUMBER_PER_DAY,
  sendDelayMinMs: config.SEND_DELAY_MIN_MS,
  sendDelayMaxMs: config.SEND_DELAY_MAX_MS,
  amoPipelineId: null,
  amoStatusId: null,
})

const KEY = 'app'

let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache !== null) return cache
  const rows = await sql<{ value: Partial<Settings> }[]>`
    select value from settings where key = ${KEY}
  `
  cache = { ...DEFAULTS(), ...(rows[0]?.value ?? {}) }
  return cache
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await sql`
    insert into settings (key, value, updated_at)
    values (${KEY}, ${sql.json(next as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `
  cache = next
  return next
}

export function invalidateSettingsCache(): void {
  cache = null
}

/** Нормализует номер к виду 79991234567 для сравнения со списком «личных». */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  return digits
}

export function isPersonalNumber(settings: Settings, phone: string): boolean {
  const target = normalizePhone(phone)
  if (target === '') return false
  return settings.personalNumbers.some((n) => normalizePhone(n) === target)
}
