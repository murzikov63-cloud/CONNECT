import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Числа статусов WhatsApp легко перепутать на единицу, и тогда менеджер
 * видит «прочитано» у сообщения, которое клиент не открывал. Сверяем
 * нашу таблицу с той, что объявлена в самой библиотеке.
 */
describe('таблица статусов WhatsApp', () => {
  const исходник = readFileSync('src/wa/session.ts', 'utf8')
  const таблица = /const STATUS_BY_CODE[^{]*\{([^}]*)\}/.exec(исходник)?.[1] ?? ''
  const прочитать = (код: number): string =>
    new RegExp(`\\b${код}:\\s*'([a-z]+)'`).exec(таблица)?.[1] ?? 'нет'

  it('доставлено — это три, а не два', () => {
    expect(прочитать(3)).toBe('delivered')
  })

  it('прочитано — это четыре', () => {
    expect(прочитать(4)).toBe('read')
  })

  it('принятое сервером не выдаём за доставленное', () => {
    expect(прочитать(2)).toBe('sent')
  })
})
