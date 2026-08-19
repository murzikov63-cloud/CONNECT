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

describe('окно охлаждения задаётся вызовом', () => {
  beforeEach(() => resetAlertCooldown())

  it('суточное окно не пропускает повтор через 10 минут', async () => {
    const DAY = 24 * 60 * 60 * 1000
    // Иначе известное состояние, с которым временно живут, шлёт владельцу
    // одно и то же сообщение весь день — так и случилось с подписью вебхуков.
    expect(await alert('warn', 'Известная беда', {}, DAY)).toBe(true)
    expect(await alert('warn', 'Известная беда', {}, DAY)).toBe(false)
  })
})
