import { createHash, createHmac } from 'node:crypto'

/**
 * Подпись запросов к Chat API amoCRM (amojo).
 *
 * amoCRM проверяет четыре заголовка: Date, Content-Type, Content-MD5 и
 * X-Signature. Подписывается склейка метода, md5 тела, типа, даты и пути —
 * порядок и переводы строк менять нельзя, иначе будет 401.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Дата в формате RFC 2822 с числовым смещением: `Thu, 18 Aug 2026 05:00:00 +0000`.
 * Штатный toUTCString() даёт на конце «GMT», а amoCRM ждёт «+0000».
 */
export function rfc2822Date(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${DAYS[date.getUTCDay()]}, ${p(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:` +
    `${p(date.getUTCSeconds())} +0000`
  )
}

// Пересечение с Record нужно, чтобы объект годился как HeadersInit для fetch.
export type SignedHeaders = Record<string, string> & {
  Date: string
  'Content-Type': string
  'Content-MD5': string
  'X-Signature': string
}

export function signRequest(
  method: string,
  path: string,
  body: string,
  secretKey: string,
  date: Date = new Date(),
): SignedHeaders {
  const contentType = 'application/json'
  const checkSum = createHash('md5').update(body).digest('hex')
  const dateHeader = rfc2822Date(date)

  const toSign = [method.toUpperCase(), checkSum, contentType, dateHeader, path].join('\n')
  const signature = createHmac('sha1', secretKey).update(toSign).digest('hex')

  return {
    Date: dateHeader,
    'Content-Type': contentType,
    'Content-MD5': checkSum.toLowerCase(),
    'X-Signature': signature.toLowerCase(),
  }
}
