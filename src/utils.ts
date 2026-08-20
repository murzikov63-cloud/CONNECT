/** Случайная задержка в заданном окне — «human-like» отправка (раздел 5 ТЗ). */
export function randomDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs
  return minMs + Math.floor(Math.random() * (maxMs - minMs))
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Приводит номер к международному виду.
 *
 * В карточках amoCRM номера живут как попало: «8 966 038-88-83»,
 * «+7 966…», «966…». Мессенджеры же ищут человека по одному строгому
 * виду, и по «8…» не находят никого. Российские номера узнаём по длине
 * и первой цифре, остальные оставляем как есть — гадать не беремся.
 */
export function toInternationalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.length === 10 && digits.startsWith('9')) return `7${digits}`
  return digits
}
