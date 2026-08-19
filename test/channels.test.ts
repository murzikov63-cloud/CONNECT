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

  it('писать первым нельзя только там, где подключаемся ботом', () => {
    // WhatsApp и Телеграм подключаются как обычный клиент — ограничений нет.
    expect(CAPABILITIES.whatsapp.canInitiate).toBe(true)
    expect(CAPABILITIES.telegram.canInitiate).toBe(true)
    // MAX подключается ботом, а бот не может написать первым.
    expect(CAPABILITIES.max.canInitiate).toBe(false)
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

  it('для Телеграма драйвер есть', () => {
    const driver = createDriver('telegram', 'id-2', 'Тест')
    expect(driver.kind).toBe('telegram')
    expect(driver.channelId).toBe('id-2')
  })

  it('для неготовых каналов ошибка понятна человеку', () => {
    expect(() => createDriver('max', 'id-3', 'Тест')).toThrow(/MAX/)
  })
})
