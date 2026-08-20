import { config } from './config/index.js'
import { sql } from './db/index.js'

/** Настройки, которые Анатолий меняет из админки без правки кода. */
export interface Settings {
  /** «Личные» номера — переписку с ними в amoCRM не отдаём. */
  personalNumbers: string[]
  ignoreGroups: boolean
  newChatsPerNumberPerDay: number
  /** Пауза перед первым сообщением новому контакту. */
  newChatDelayMinMs: number
  newChatDelayMaxMs: number
  /** Пауза перед ответом в уже идущем диалоге. */
  replyDelayMinMs: number
  replyDelayMaxMs: number
  /** Воронка и этап для новых лидов; null — «Неразобранное». */
  amoPipelineId: number | null
  amoStatusId: number | null
  /**
   * Кем в amoCRM подписаны сообщения, отправленные менеджером прямо
   * из мессенджера. Свой выдуманный отправитель amoCRM не принимает —
   * нужна ссылка на её собственного пользователя. Этот идентификатор она
   * присылает в каждом вебхуке, поэтому запоминаем его сами.
   */
  amoSenderRefId: string | null
}

const DEFAULTS = (): Settings => ({
  personalNumbers: [],
  ignoreGroups: config.IGNORE_GROUPS,
  newChatsPerNumberPerDay: config.NEW_CHATS_PER_NUMBER_PER_DAY,
  newChatDelayMinMs: config.NEW_CHAT_DELAY_MIN_MS,
  newChatDelayMaxMs: config.NEW_CHAT_DELAY_MAX_MS,
  replyDelayMinMs: config.REPLY_DELAY_MIN_MS,
  replyDelayMaxMs: config.REPLY_DELAY_MAX_MS,
  amoPipelineId: null,
  amoStatusId: null,
  amoSenderRefId: null,
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
