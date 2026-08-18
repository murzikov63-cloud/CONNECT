/** Случайная задержка в заданном окне — «human-like» отправка (раздел 5 ТЗ). */
export function randomDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs
  return minMs + Math.floor(Math.random() * (maxMs - minMs))
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
