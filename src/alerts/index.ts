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
const lastSent = new Map<string, number>()

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
  const prev = lastSent.get(key)
  if (prev !== undefined && now - prev < cooldownMs) return false
  lastSent.set(key, now)

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
  lastSent.clear()
}
