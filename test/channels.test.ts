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

  it('все три мессенджера подключаются личным аккаунтом и умеют писать первыми', () => {
    for (const kind of ['whatsapp', 'telegram', 'max'] as const) {
      expect(CAPABILITIES[kind].connect).toBe('qr')
      expect(CAPABILITIES[kind].canInitiate).toBe(true)
    }
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

describe('MAX', () => {
  it('драйвер есть и подключается по QR', async () => {
    const driver = createDriver('max', 'id-max', 'MAX продажи')
    expect(driver.kind).toBe('max')
    expect(CAPABILITIES.max.connect).toBe('qr')
  })

  it('умеет писать первым — есть поиск по телефону', () => {
    expect(CAPABILITIES.max.canInitiate).toBe(true)
  })

  it('пока не в сети — отправка отклоняется понятной ошибкой', async () => {
    const driver = createDriver('max', 'id-max2', 'MAX продажи')
    await expect(
      driver.send({
        channelId: 'id-max2',
        externalChatId: '1',
        type: 'text',
        body: 'привет',
      }),
    ).rejects.toThrow(/не в сети/)
  })
})
