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

  it('WhatsApp и Телеграм подключаются одинаково — по QR', () => {
    expect(CAPABILITIES.whatsapp.connect).toBe('qr')
    expect(CAPABILITIES.telegram.connect).toBe('qr')
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

describe('защита от двойной записи своих сообщений', () => {
  // Без неё ответ менеджера попал бы в карточку дважды: один раз из amoCRM,
  // второй — эхом, которым мессенджер возвращает нам нашу же отправку.
  it('помеченное узнаётся', async () => {
    const { ChannelManager } = await import('../src/channels/manager.js')
    const m = new ChannelManager()
    m.markSelfSent('канал-1', 'msg-1')
    expect(m.isSelfSent('канал-1', 'msg-1')).toBe(true)
  })

  it('чужое сообщение своим не считается', async () => {
    const { ChannelManager } = await import('../src/channels/manager.js')
    const m = new ChannelManager()
    m.markSelfSent('канал-1', 'msg-1')
    expect(m.isSelfSent('канал-1', 'msg-2')).toBe(false)
  })

  it('идентификаторы разных каналов не путаются', async () => {
    const { ChannelManager } = await import('../src/channels/manager.js')
    const m = new ChannelManager()
    m.markSelfSent('канал-1', 'msg-1')
    // В Телеграме идентификаторы — обычные числа, они легко совпадут
    // с идентификаторами другого канала.
    expect(m.isSelfSent('канал-2', 'msg-1')).toBe(false)
  })

  it('через десять минут пометка отпускает', async () => {
    const { ChannelManager } = await import('../src/channels/manager.js')
    const m = new ChannelManager()
    const now = Date.now()
    m.markSelfSent('канал-1', 'msg-1')
    expect(m.isSelfSent('канал-1', 'msg-1', now + 9 * 60 * 1000)).toBe(true)
    expect(m.isSelfSent('канал-1', 'msg-1', now + 11 * 60 * 1000)).toBe(false)
  })
})
