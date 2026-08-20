import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { sql } from '../db/index.js'

/**
 * Временный пароль для чужого человека.
 *
 * Живой случай: номер WhatsApp принадлежит сотруднику, телефон у него,
 * а привязка идёт через нашу админку. QR живёт секунды — переслать его
 * картинкой нельзя, надо, чтобы человек открыл админку сам. Отдавать ему
 * общий пароль нельзя: он один на всех и не отзывается.
 *
 * Поэтому отдельный пароль: со сроком, отзываемый в один запрос и с правом
 * только на подключение номера — настройки и переписка ему не видны.
 */

const KEY = 'guest_access'

/** Без похожих друг на друга знаков: пароль диктуют голосом или в переписке. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface StoredAccess {
  hash: string
  expiresAt: number
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function generatePassword(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

async function load(): Promise<StoredAccess | null> {
  const rows = await sql<{ value: StoredAccess }[]>`
    select value from settings where key = ${KEY}
  `
  return rows[0]?.value ?? null
}

/** Заводит новый временный пароль, отменяя прежний. */
export async function issueGuestPassword(
  hours: number,
  now: number = Date.now(),
): Promise<{ password: string; expiresAt: number }> {
  const password = generatePassword()
  const expiresAt = now + Math.round(hours * 60 * 60 * 1000)
  const value: StoredAccess = { hash: hashPassword(password), expiresAt }
  await sql`
    insert into settings (key, value, updated_at)
    values (${KEY}, ${sql.json(value as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `
  return { password, expiresAt }
}

export async function revokeGuestPassword(): Promise<void> {
  await sql`delete from settings where key = ${KEY}`
}

/** Когда истекает действующий временный пароль. null — его нет. */
export async function guestAccessExpiry(now: number = Date.now()): Promise<number | null> {
  const stored = await load()
  if (stored === null || stored.expiresAt <= now) return null
  return stored.expiresAt
}

/** Проверяет пароль гостя. Возвращает срок его действия или null. */
export async function checkGuestPassword(
  password: string,
  now: number = Date.now(),
): Promise<number | null> {
  if (password === '') return null
  const stored = await load()
  if (stored === null || stored.expiresAt <= now) return null

  const a = Buffer.from(hashPassword(password))
  const b = Buffer.from(stored.hash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return stored.expiresAt
}
