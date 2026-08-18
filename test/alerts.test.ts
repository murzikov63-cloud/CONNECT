import { beforeEach, describe, expect, it } from 'vitest'
import { alert, resetAlertCooldown } from '../src/alerts/index.js'

describe('дедупликация алертов', () => {
  beforeEach(() => {
    resetAlertCooldown()
  })

  it('одинаковый алерт не повторяется в окне охлаждения', async () => {
    // Иначе отвалившаяся ночью сессия пришлёт владельцу тысячу сообщений.
    expect(await alert('error', 'Номер отвалился', { Номер: 'A' })).toBe(true)
    expect(await alert('error', 'Номер отвалился', { Номер: 'A' })).toBe(false)
    expect(await alert('error', 'Номер отвалился', { Номер: 'B' })).toBe(false)
  })

  it('разные алерты проходят независимо', async () => {
    expect(await alert('error', 'Первый', {})).toBe(true)
    expect(await alert('warn', 'Второй', {})).toBe(true)
  })

  it('один и тот же текст на разных уровнях — разные алерты', async () => {
    expect(await alert('warn', 'Номер отвалился', {})).toBe(true)
    expect(await alert('error', 'Номер отвалился', {})).toBe(true)
  })
})
