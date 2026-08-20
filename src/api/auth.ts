import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config/index.js'

/**
 * Вход в админку.
 *
 * Фронт живёт на чужом домене (Lovable), поэтому зашивать в него постоянный
 * API-ключ нельзя — его увидит любой, кто откроет страницу. Вместо этого
 * пароль меняется на токен с сроком жизни. Токен подписан и самодостаточен,
 * хранилища сессий не нужно: сервис можно перезапускать, вход не слетит.
 *
 * X-Api-Key остаётся для скриптов и мониторинга.
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Что позволено вошедшему. `admin` — всё; `guest` — только подключение
 * номера, по временному паролю (см. api/guest.ts).
 */
export type Scope = 'admin' | 'guest'

function sign(payload: string): string {
  return createHmac('sha256', config.ADMIN_API_KEY).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function issueToken(
  now: number = Date.now(),
  scope: Scope = 'admin',
  expiresAt: number = now + TOKEN_TTL_MS,
): { token: string; expiresAt: number } {
  // У обычного входа в теле только срок — таким токен был с самого начала,
  // и выданные раньше продолжают работать.
  const payload = scope === 'admin' ? String(expiresAt) : `${expiresAt}:${scope}`
  return { token: `${payload}.${sign(payload)}`, expiresAt }
}

/** Права вошедшего или null, если токен поддельный либо просрочен. */
export function verifyToken(token: string, now: number = Date.now()): Scope | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!safeEqual(signature, sign(payload))) return null

  const [rawExpiry, rawScope] = payload.split(':')
  const expiresAt = Number(rawExpiry)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  if (rawScope === undefined) return 'admin'
  return rawScope === 'guest' ? 'guest' : null
}

export function checkPassword(password: string): boolean {
  if (config.ADMIN_PASSWORD === '') return false
  return safeEqual(password, config.ADMIN_PASSWORD)
}

/**
 * Простой ограничитель попыток входа. Пароль один на всех, поэтому перебор —
 * реальный сценарий, а не теоретический.
 */
const attempts = new Map<string, { count: number; until: number }>()
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60 * 1000

export function loginBlocked(ip: string, now: number = Date.now()): boolean {
  const rec = attempts.get(ip)
  if (rec === undefined) return false
  if (now > rec.until) {
    attempts.delete(ip)
    return false
  }
  return rec.count >= MAX_ATTEMPTS
}

export function registerFailure(ip: string, now: number = Date.now()): void {
  const rec = attempts.get(ip)
  if (rec === undefined || now > rec.until) {
    attempts.set(ip, { count: 1, until: now + LOCK_MS })
    return
  }
  rec.count++
  rec.until = now + LOCK_MS
}

export function registerSuccess(ip: string): void {
  attempts.delete(ip)
}

export function resetLoginLimiter(): void {
  attempts.clear()
}

/** Разбирает список разрешённых источников, понимая звёздочку. */
export function parseCorsOrigins(raw: string): (string | RegExp)[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((entry) => {
      if (!entry.includes('*')) return entry
      // Звёздочка заменяется на «что угодно, кроме косой черты»: с `.*`
      // шаблон https://*.lovable.app совпал бы и с https://чужой.сайт/x.lovable.app.
      const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      return new RegExp(`^${escaped}$`)
    })
}
