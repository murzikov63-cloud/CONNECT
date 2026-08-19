import { describe, expect, it } from 'vitest'
import { createDriver, isKnownKind } from '../src/channels/registry.js'
import { CAPABILITIES, CHANNEL_TITLES } from '../src/channels/types.js'

describe('типы каналов', () => {
  it('у каждого типа есть название и описание возможностей', () => {
    for (const kind of Object.keys(CAPABILITIES)) {
      expect(CHANNEL_TITLES[kind as keyof typeof CHANNEL_TITLES]).toBeTruthy()
    }
  })

  it('риск блокировки отмечен только у WhatsApp', () => {
    expect(CAPABILITIES.whatsapp.banRisk).toBe(true)
    expect(CAPABILITIES.telegram.banRisk).toBe(false)
    expect(CAPABILITIES.max.banRisk).toBe(false)
  })

  it('первым написать может только WhatsApp', () => {
    expect(CAPABILITIES.whatsapp.canInitiate).toBe(true)
    expect(CAPABILITIES.telegram.canInitiate).toBe(false)
  })

  it('чужие названия не считаются известными', () => {
    expect(isKnownKind('whatsapp')).toBe(true)
    expect(isKnownKind('telegram')).toBe(true)
    expect(isKnownKind('viber')).toBe(false)
    expect(isKnownKind('')).toBe(false)
  })
})

describe('подбор драйвера', () => {
  it('для WhatsApp драйвер есть', () => {
    const driver = createDriver('whatsapp', 'id-1', 'Тест')
    expect(driver.kind).toBe('whatsapp')
    expect(driver.channelId).toBe('id-1')
  })

  it('для неготовых каналов ошибка понятна человеку', () => {
    expect(() => createDriver('telegram', 'id-2', 'Тест')).toThrow(/Телеграм/)
    expect(() => createDriver('max', 'id-3', 'Тест')).toThrow(/MAX/)
  })
})
