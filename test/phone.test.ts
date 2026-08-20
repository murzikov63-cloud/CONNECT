import { describe, expect, it } from 'vitest'
import { toInternationalPhone } from '../src/utils.js'

describe('приведение номера к международному виду', () => {
  it('восьмёрку меняет на семёрку', () => {
    expect(toInternationalPhone('8 966 038-88-83')).toBe('79660388883')
  })

  it('номер без кода страны получает семёрку', () => {
    expect(toInternationalPhone('966 038-88-83')).toBe('79660388883')
  })

  it('уже правильный номер не трогает', () => {
    expect(toInternationalPhone('+7 (966) 038-88-83')).toBe('79660388883')
  })

  it('иностранный номер оставляет как есть', () => {
    // Гадать про чужие правила не беремся: отдаём одни цифры.
    expect(toInternationalPhone('+49 151 23456789')).toBe('4915123456789')
  })

  it('на мусоре не выдумывает номер', () => {
    expect(toInternationalPhone('')).toBe('')
    expect(toInternationalPhone('не телефон')).toBe('')
  })
})
