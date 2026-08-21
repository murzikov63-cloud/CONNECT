import { Bot } from 'grammy'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'

const logger = log('alerts')

const bot =
  config.TG_BOT_TOKEN !== '' && config.TG_ALERT_CHAT_ID !== ''
    ? new Bot(config.TG_BOT_TOKEN)
    : null

if (bot === null) {
  logger.warn('Telegram-алерты выключены: не заданы TG_BOT_TOKEN / TG_ALERT_CHAT_ID')
}

/**
 * Дедупликация: один и тот же алерт не чаще раза в 10 минут.
 * Иначе отвалившаяся сессия за ночь пришлёт тысячу сообщений.
 */
const COOLDOWN_MS = 10 * 60 * 1000
/** Для состояний, о которых уже знают и с которыми временно живут. */
export const COOLDOWN_DAILY_MS = 24 * 60 * 60 * 1000

/**
 * Где хранится, когда алерт отправляли в прошлый раз.
 *
 * В памяти этого мало: при перезапуске сервиса отсчёт начинается заново,
 * и «раз в сутки» превращается в «на каждый перезапуск». В день, когда
 * выкладок было три десятка, это и случилось.
 */
export interface CooldownStore {
  get(key: string): Promise<number | undefined>
  set(key: string, at: number): Promise<void>
}

function memoryStore(): CooldownStore {
  const map = new Map<string, number>()
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, at) => {
      map.set(key, at)
      return Promise.resolve()
    },
    clear: () => map.clear(),
  } as CooldownStore & { clear: () => void }
}

let store = memoryStore()

/** Подключает хранилище, переживающее перезапуск. Вызывается при старте. */
export function useCooldownStore(next: CooldownStore): void {
  store = next
}

export type AlertLevel = 'info' | 'warn' | 'error'

const icon: Record<AlertLevel, string> = { info: 'ℹ️', warn: '⚠️', error: '🔴' }

/** Возвращает false, если алерт подавлен окном охлаждения. */
export async function alert(
  level: AlertLevel,
  title: string,
  details?: Record<string, unknown>,
  cooldownMs: number = COOLDOWN_MS,
): Promise<boolean> {
  const key = `${level}:${title}`
  const now = Date.now()
  // Не смогли прочитать отметку — лучше сообщить лишний раз, чем промолчать.
  const prev = await store.get(key).catch(() => undefined)
  if (prev !== undefined && now - prev < cooldownMs) return false
  await store.set(key, now).catch(() => undefined)

  const lines = [`${icon[level]} ${title}`]
  if (details !== undefined) {
    for (const [k, v] of Object.entries(details)) lines.push(`${k}: ${String(v)}`)
  }
  const text = lines.join('\n')

  logger.info({ level, title }, 'алерт')
  if (bot === null) return true

  try {
    await bot.api.sendMessage(config.TG_ALERT_CHAT_ID, text)
  } catch (err) {
    logger.error({ err }, 'не удалось отправить алерт в Telegram')
  }
  return true
}

/** Сбрасывает окно дедупликации — нужен в тестах. */
export function resetAlertCooldown(): void {
  store = memoryStore()
}
