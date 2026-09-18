import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import { CAPABILITIES } from '../channels/types.js'
import type { ChannelDriver } from '../channels/types.js'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import type { InboundMessage, MessageType, OutboundMessage } from '../types.js'
import { outgoingLocalFile } from '../wa/media.js'

/**
 * Канал мессенджера MAX.
 *
 * Сам с MAX не разговаривает: этим занимается отдельная служба на Python
 * (папка max-bridge), потому что рабочая библиотека для личного аккаунта
 * существует только там. Драйвер ходит к ней по HTTP внутри докер-сети
 * и приводит всё к нашему общему виду.
 */

interface BridgeStatus {
  status: 'new' | 'connecting' | 'qr' | 'online' | 'offline'
  qrUrl?: string | null
  phone?: string
  userId?: string
  error?: string
}

/** Что присылает служба, когда в MAX приходит сообщение. */
export interface MaxIncoming {
  channelId: string
  externalMessageId: string
  externalChatId: string
  senderId: string
  fromMe: boolean
  type: string
  text: string
  media: { path: string; mime: string; name: string; size: number } | null
  occurredAt: number
}

const POLL_MS = 2000

/**
 * Приводит время сообщения MAX к миллисекундам.
 *
 * Значения меньше десяти миллиардов — это секунды: столько миллисекунд
 * прошло бы лишь к 1970 году с небольшим, а такого времени у сообщений
 * не бывает.
 */
export function msFromMaxTime(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Date.now()
  return value < 1e10 ? value * 1000 : value
}

export class MaxDriver extends EventEmitter implements ChannelDriver {
  readonly kind = 'max' as const
  readonly channelId: string
  readonly capabilities = CAPABILITIES.max
  readonly label: string

  private status: BridgeStatus['status'] = 'new'
  private lastQrUrl: string | null = null
  private poll: NodeJS.Timeout | null = null
  private readonly logger

  constructor(channelId: string, label: string) {
    super()
    this.channelId = channelId
    this.label = label
    this.logger = log('max').child({ channelId, label })
  }

  private async bridge<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${config.MAX_BRIDGE_URL}/channels/${this.channelId}${path}`, {
      method,
      headers: {
        'X-Bridge-Secret': config.BRIDGE_SECRET,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`служба MAX ответила ${response.status}: ${text.slice(0, 200)}`)
    }
    return (text === '' ? {} : JSON.parse(text)) as T
  }

  async start(): Promise<void> {
    this.emit('status', 'connecting', {})
    await this.bridge('POST', '/start')
    this.startPolling()
  }

  /**
   * Служба не умеет сама сообщать о смене состояния, поэтому спрашиваем.
   * Заодно это проверка, что она вообще жива.
   */
  private startPolling(): void {
    if (this.poll !== null) return
    this.poll = setInterval(() => {
      void this.checkStatus().catch((err: unknown) => {
        this.logger.error({ err }, 'служба MAX не отвечает')
        if (this.status !== 'offline') {
          this.status = 'offline'
          this.emit('status', 'offline', { reason: 'служба MAX не отвечает' })
        }
      })
    }, POLL_MS)
  }

  private async checkStatus(): Promise<void> {
    const state = await this.bridge<BridgeStatus>('GET', '/status')

    if (state.qrUrl != null && state.qrUrl !== this.lastQrUrl) {
      this.lastQrUrl = state.qrUrl
      const dataUrl = await QRCode.toDataURL(state.qrUrl, { margin: 1, width: 320 })
      this.emit('status', 'qr', {})
      this.emit('qr', dataUrl)
    }

    // Служба могла перезапуститься и забыть про канал. Раньше сервис этого
    // не замечал: состояние оставалось прежним, а сообщения не приходили.
    if (state.status === 'new') {
      this.logger.warn('служба MAX потеряла канал, поднимаю заново')
      this.status = 'connecting'
      this.emit('status', 'connecting', {})
      await this.bridge('POST', '/start')
      return
    }

    if (state.status === this.status) return
    this.status = state.status

    if (state.status === 'online') {
      this.lastQrUrl = null
      this.logger.info({ phone: state.phone }, 'MAX в сети')
      this.emit('status', 'online', {
        ...(state.phone !== undefined && state.phone !== '' ? { phone: state.phone } : {}),
        ...(state.userId !== undefined ? { externalId: state.userId } : {}),
      })
    } else if (state.status === 'offline') {
      this.emit('status', 'offline', {
        reason: state.error !== undefined && state.error !== '' ? state.error : 'связь потеряна',
      })
    }
  }

  /** Вызывается, когда служба принесла входящее сообщение. */
  /** Собеседник прочитал переписку — MAX отмечает это временем. */
  ingestRead(payload: { externalChatId: string; upToMs: number }): void {
    this.emit('read-up-to-time', {
      externalChatId: payload.externalChatId,
      upToMs: payload.upToMs,
    })
  }

  ingest(payload: MaxIncoming): void {
    const msg: InboundMessage = {
      channelId: this.channelId,
      externalMessageId: payload.externalMessageId,
      externalChatId: payload.externalChatId,
      // MAX не отдаёт телефон собеседника в самом сообщении — он появится
      // позже, если менеджер найдёт человека по номеру.
      phone: '',
      isGroup: false,
      fromMe: payload.fromMe,
      pushName: '',
      type: payload.type as MessageType,
      body: payload.text,
      ...(payload.media !== null ? { media: payload.media } : {}),
      // MAX отсчитывает время в миллисекундах, а не в секундах. Если
      // умножить его ещё раз на тысячу, получается пятьдесят восьмое
      // тысячелетие, и база отказывается такое принимать — входящее
      // теряется целиком. Отличаем одно от другого по величине.
      occurredAt: new Date(msFromMaxTime(payload.occurredAt)),
    }
    this.emit('inbound', msg)
  }

  async send(out: OutboundMessage): Promise<string> {
    if (this.status !== 'online') throw new Error(`Канал ${this.label} не в сети`)

    const filePath = await outgoingLocalFile(this.channelId, out)
    const result = await this.bridge<{ messageId: string }>('POST', '/send', {
      chatId: out.externalChatId,
      text: out.body === '' ? null : out.body,
      type: out.type,
      ...(out.quotedExternalMessageId !== undefined
        ? { replyTo: out.quotedExternalMessageId }
        : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(out.mediaName !== undefined ? { fileName: out.mediaName } : {}),
    })
    if (result.messageId === '') throw new Error('MAX не вернул номер отправленного сообщения')
    return result.messageId
  }

  /**
   * Ищет собеседника по телефону — чтобы менеджер мог написать первым.
   * Возвращает номер переписки, а не номер человека: писать в MAX нужно
   * именно в переписку, и для личного разговора она существует всегда,
   * даже если он ещё не начинался.
   */
  async findChatByPhone(phone: string, name = ''): Promise<string | null> {
    const digits = phone.replace(/\D/g, '')
    if (digits === '') return null
    // Имя нужно, если номера ещё нет в контактах: MAX ищет прежде всего
    // среди знакомых, поэтому номер приходится сначала добавить.
    const res = await this.bridge<{ found: boolean; chatId?: string }>(
      'GET',
      `/search?phone=${encodeURIComponent(digits)}&name=${encodeURIComponent(name)}`,
    )
    return res.found && res.chatId !== undefined && res.chatId !== '' ? res.chatId : null
  }

  isReady(): boolean {
    return this.status === 'online'
  }

  async disconnect(): Promise<void> {
    await this.bridge('POST', '/stop').catch(() => {
      /* служба могла уже забыть про канал */
    })
    this.status = 'offline'
  }

  stop(): void {
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    this.status = 'offline'
  }
}
