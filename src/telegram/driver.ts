import { EventEmitter } from 'node:events'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import { CAPABILITIES } from '../channels/types.js'
import type { ChannelDriver } from '../channels/types.js'
import type { MediaPayload, OutboundMessage } from '../types.js'
import { absoluteMediaPath, saveMedia } from '../wa/media.js'
import { loadSession, saveSession } from './auth-state.js'
import { Api, NewMessage, StringSession, TelegramClient } from './gramjs.js'
import type { TgClient } from './gramjs.js'
import { displayName, extractContent, normalizeInbound } from './normalize.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Подключение аккаунта Телеграма напрямую — так же, как это делают сторонние
 * клиенты. Ключи приложения берутся с my.telegram.org, вход по коду
 * выполняется скриптами scripts/telegram-login*.ts.
 */
export class TelegramDriver extends EventEmitter implements ChannelDriver {
  readonly kind = 'telegram' as const
  readonly channelId: string
  readonly capabilities = CAPABILITIES.telegram
  readonly label: string

  private client: TgClient | null = null
  private ready = false
  private readonly logger

  constructor(channelId: string, label: string) {
    super()
    this.channelId = channelId
    this.label = label
    this.logger = log('telegram').child({ channelId, label })
  }

  async start(): Promise<void> {
    if (config.TG_API_ID === 0 || config.TG_API_HASH === '') {
      throw new Error('Не заданы TG_API_ID и TG_API_HASH — см. docs/anatoly/05-telegram-connect.md')
    }

    this.emit('status', 'connecting', {})
    const saved = await loadSession(this.channelId)
    if (saved === '') {
      // Входа ещё не было: канал создан, но код не вводили.
      this.emit('status', 'logged_out', { reason: 'вход в Телеграм не выполнен' })
      return
    }

    const client = new TelegramClient(
      new StringSession(saved),
      config.TG_API_ID,
      config.TG_API_HASH,
      { connectionRetries: 100, retryDelay: 2000, autoReconnect: true },
    )
    // Библиотека шумит в консоль; свои сообщения мы пишем через общий журнал.
    client.setLogLevel?.('error')

    await client.connect()
    this.client = client

    if (!(await client.isUserAuthorized())) {
      this.ready = false
      this.emit('status', 'logged_out', { reason: 'сессия больше не действует' })
      return
    }

    const me = await client.getMe()
    const phone = String(me?.phone ?? '').replace(/\D/g, '')

    client.addEventHandler((event: any) => {
      void this.handleIncoming(event).catch((err: unknown) =>
        this.logger.error({ err }, 'ошибка обработки входящего'),
      )
    }, new NewMessage({}))

    this.ready = true
    this.logger.info({ phone }, 'аккаунт Телеграма в сети')
    this.emit('status', 'online', { phone })
  }

  private async handleIncoming(event: any): Promise<void> {
    const msg = event?.message
    if (msg == null) return

    const isGroup = msg.isGroup === true || msg.isChannel === true
    let sender: any = null
    try {
      sender = await msg.getSender()
    } catch {
      /* отправитель мог удалить аккаунт */
    }

    const normalized = normalizeInbound(this.channelId, msg, sender, isGroup)
    if (normalized === null) return

    const content = extractContent(msg)
    if (content.hasMedia) {
      const media = await this.downloadMedia(msg, normalized.externalMessageId, content)
      if (media !== null) normalized.media = media
    }

    this.emit('inbound', normalized)
  }

  private async downloadMedia(
    msg: any,
    externalMessageId: string,
    content: { mediaMime?: string; mediaName?: string },
  ): Promise<MediaPayload | null> {
    try {
      const buffer = (await this.client?.downloadMedia(msg, {})) as Buffer | undefined
      if (buffer === undefined || buffer.length === 0) return null
      return await saveMedia(
        this.channelId,
        externalMessageId,
        buffer,
        content.mediaMime ?? 'application/octet-stream',
        content.mediaName,
      )
    } catch (err) {
      this.logger.error({ err, externalMessageId }, 'не удалось скачать вложение')
      return null
    }
  }

  async send(out: OutboundMessage): Promise<string> {
    const client = this.client
    if (client === null || !this.ready) throw new Error(`Канал ${this.label} не в сети`)

    const peer = out.externalChatId
    const options: Record<string, unknown> = {}
    if (out.body !== '') options['message'] = out.body
    if (out.quotedExternalMessageId !== undefined) {
      options['replyTo'] = Number(out.quotedExternalMessageId)
    }
    if (out.mediaPath !== undefined) {
      options['file'] = out.mediaPath.startsWith('http')
        ? out.mediaPath
        : absoluteMediaPath(out.mediaPath)
      // Голосовые Телеграм показывает кружком-дорожкой только с этим признаком.
      if (out.type === 'voice') options['voiceNote'] = true
    }

    const sent = await client.sendMessage(peer, options)
    const id = String(sent?.id ?? '')
    if (id === '') throw new Error('Телеграм не вернул номер отправленного сообщения')
    return id
  }

  async fetchAvatar(externalChatId: string): Promise<string | null> {
    // Телеграм отдаёт аватар файлом, а не ссылкой. Сохраняем как вложение
    // и отдаём amoCRM по нашей подписанной ссылке.
    const client = this.client
    if (client === null) return null
    try {
      const buffer = (await client.downloadProfilePhoto(externalChatId, {})) as Buffer | undefined
      if (buffer === undefined || buffer.length === 0) return null
      const saved = await saveMedia(
        this.channelId,
        `avatar-${externalChatId}`,
        buffer,
        'image/jpeg',
      )
      return saved.path
    } catch {
      return null
    }
  }

  isReady(): boolean {
    return this.ready && this.client !== null
  }

  /** Полный выход: сессия перестаёт действовать и на стороне Телеграма. */
  async disconnect(): Promise<void> {
    try {
      await this.client?.invoke(new Api.auth.LogOut())
    } catch {
      /* уже вышли или связи нет */
    }
    this.ready = false
    await saveSession(this.channelId, '')
  }

  stop(): void {
    this.ready = false
    try {
      void this.client?.disconnect()
    } catch {
      /* соединение уже закрыто */
    }
    this.client = null
  }

  /** Имя собеседника — используется при разборе входящих. */
  static displayName = displayName
}
