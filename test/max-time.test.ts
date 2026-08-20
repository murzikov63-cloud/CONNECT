import { describe, expect, it } from 'vitest'
import { msFromMaxTime } from '../src/max/driver.js'

describe('время сообщения из MAX', () => {
  it('миллисекунды остаются как есть', () => {
    // 20 августа 2026 года, а не пятьдесят восьмое тысячелетие.
    expect(new Date(msFromMaxTime(1787204776000)).getUTCFullYear()).toBe(2026)
  })

  it('секунды переводятся в миллисекунды', () => {
    expect(msFromMaxTime(1787204776)).toBe(1787204776000)
  })

  it('пустое время заменяется текущим', () => {
    const now = Date.now()
    expect(msFromMaxTime(0)).toBeGreaterThanOrEqual(now)
  })
})
