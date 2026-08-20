import { describe, expect, it } from 'vitest'
import { eventsPath, parseEvent } from '../src/amo/events.js'

// Так amoCRM присылает событие: полем формы со скобками в имени.
const НОВЫЙ_КОНТАКТ =
  'contacts%5Badd%5D%5B0%5D%5Bid%5D=45570297&contacts%5Badd%5D%5B0%5D%5Bname%5D=%D0%90%D0%BD%D0%B0%D1%82%D0%BE%D0%BB%D0%B8%D0%B9&account%5Bid%5D=123'
const НОВАЯ_СДЕЛКА = 'leads%5Badd%5D%5B0%5D%5Bid%5D=32540755&leads%5Badd%5D%5B0%5D%5Bprice%5D=0'

describe('событие amoCRM', () => {
  it('находит номер нового контакта', () => {
    expect(parseEvent(НОВЫЙ_КОНТАКТ)).toEqual({ contacts: [45570297], leads: [] })
  })

  it('находит номер новой сделки', () => {
    expect(parseEvent(НОВАЯ_СДЕЛКА)).toEqual({ contacts: [], leads: [32540755] })
  })

  it('берёт всех, кого прислали разом', () => {
    const both = `${НОВЫЙ_КОНТАКТ}&${НОВАЯ_СДЕЛКА}&contacts%5Badd%5D%5B1%5D%5Bid%5D=7`
    const parsed = parseEvent(both)
    expect(parsed.contacts).toEqual([45570297, 7])
    expect(parsed.leads).toEqual([32540755])
  })

  it('изменение контакта за новое не считает', () => {
    // Подписаны мы только на добавление; правки шлют то же поле с update.
    expect(parseEvent('contacts%5Bupdate%5D%5B0%5D%5Bid%5D=1').contacts).toEqual([])
  })

  it('на мусор не падает', () => {
    expect(parseEvent('')).toEqual({ contacts: [], leads: [] })
    expect(parseEvent('%%%').contacts).toEqual([])
  })

  it('адрес события скрывает тайную часть в пути', () => {
    expect(eventsPath('тайна')).toBe('/amo-events/тайна')
  })
})
