import { describe, expect, it } from 'vitest'
import { isPersonalNumber, normalizePhone } from '../src/settings.js'
import type { Settings } from '../src/settings.js'
import { randomDelay } from '../src/utils.js'

const settings = (personal: string[]): Settings => ({
  personalNumbers: personal,
  ignoreGroups: true,
  newChatsPerNumberPerDay: 30,
  sendDelayMinMs: 2000,
  sendDelayMaxMs: 8000,
  amoPipelineId: null,
  amoStatusId: null,
})

describe('normalizePhone', () => {
  it('приводит восьмёрку к семёрке', () => {
    expect(normalizePhone('89991234567')).toBe('79991234567')
  })

  it('чистит форматирование', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567')
  })
})

describe('isPersonalNumber', () => {
  it('узнаёт номер в любом написании', () => {
    const s = settings(['+7 999 123-45-67'])
    expect(isPersonalNumber(s, '79991234567')).toBe(true)
    expect(isPersonalNumber(s, '89991234567')).toBe(true)
  })

  it('чужой номер не считает личным', () => {
    expect(isPersonalNumber(settings(['79991234567']), '79997654321')).toBe(false)
  })

  it('пустой телефон (группа) личным не считается', () => {
    expect(isPersonalNumber(settings(['79991234567']), '')).toBe(false)
  })
})

describe('randomDelay', () => {
  it('держится в заданном окне', () => {
    for (let i = 0; i < 200; i++) {
      const d = randomDelay(2000, 8000)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThan(8000)
    }
  })

  it('вырожденное окно возвращает минимум', () => {
    expect(randomDelay(3000, 3000)).toBe(3000)
    expect(randomDelay(3000, 1000)).toBe(3000)
  })
})
