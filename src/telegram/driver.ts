import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import { CAPABILITIES } from '../channels/types.js'
import type { ChannelDriver } from '../channels/types.js'
import type { MediaPayload, OutboundMessage } from '../types.js'
import { outgoingLocalFile, saveMedia } from '../wa/media.js'
import { loadSession, saveSession } from './auth-state.js'
import { Api, NewMessage, Raw, StringSession, TelegramClient, bigInt } from './gramjs.js'
import type { TgClient } from './gramjs.js'
import { displayName, extractContent, normalizeInbound } from './normalize.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Сетевые заминки, после которых надо просто подождать и повторить. */
export function isTemporaryForTests(message: string): boolean {
  return isTemporary(message)
}

function isTemporary(message: string): boolean {
  return [
    'while disconnected',
    'Please reconnect',
    'TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket',
    'Not connected',
  ].some((marker) => message.toLowerCase().includes(marker.toLowerCase()))
}

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
  private stopping = false
  /**
   * Облачный пароль держим только в памяти на время входа: это пароль
   * от аккаунта целиком, в базе ему делать нечего.
   */
  private cloudPassword: string | undefined
  private readonly logger

  constructor(channelId: string, label: string, options?: { password?: string }) {
    super()
    this.channelId = channelId
    this.label = label
    this.cloudPassword = options?.password
    this.logger = log('telegram').child({ channelId, label })
  }

  async start(): Promise<void> {
    if (config.TG_API_ID === 0 || config.TG_API_HASH === '') {
      throw new Error('Не заданы TG_API_ID и TG_API_HASH — см. docs/anatoly/05-telegram-connect.md')
    }

    this.stopping = false
    this.emit('status', 'connecting', {})
    const saved = await loadSession(this.channelId)
    if (saved === '') {
      // Входа ещё не было — показываем QR, как в WhatsApp.
      // Ждать сканирования здесь нельзя: пользователь может не подойти
      // к телефону час, а запрос на создание канала должен вернуться сразу.
      this.startQrLoginInBackground()
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
      this.logger.warn('сессия больше не действует, показываю новый QR')
      await this.detachClient()
      this.startQrLoginInBackground()
      return
    }

    await this.attach(client)
  }

  /**
   * Подписка на сообщения и переход в рабочее состояние.
   * Вызывается и при обычном старте, и сразу после входа по QR —
   * тем же соединением, которым вход и выполнялся.
   */
  private async attach(client: TgClient): Promise<void> {
    this.client = client

    const me = await client.getMe()
    const phone = String(me?.phone ?? '').replace(/\D/g, '')

    client.addEventHandler((event: any) => {
      void this.handleIncoming(event).catch((err: unknown) =>
        this.logger.error({ err }, 'ошибка обработки входящего'),
      )
    }, new NewMessage({}))

    // Прочтение Телеграм отмечает не по одному сообщению, а сразу «всё
    // в этой переписке до такого-то номера». Разворачивает эту пачку
    // в отдельные сообщения тот, кто знает, что мы отправляли.
    client.addEventHandler((update: any) => {
      if (update?.className !== 'UpdateReadHistoryOutbox') return
      const peer = update.peer ?? {}
      const chatId = String(peer.userId ?? peer.chatId ?? peer.channelId ?? '')
      const maxId = Number(update.maxId ?? 0)
      if (chatId === '' || maxId <= 0) return
      this.emit('read-up-to', { externalChatId: chatId, maxId: String(maxId) })
    }, new Raw({}))

    this.ready = true
    this.logger.info({ phone }, 'аккаунт Телеграма в сети')
    this.emit('status', 'online', { phone, externalId: String(me?.id ?? '') })
  }

  /** Аккуратно закрывает текущее соединение, чтобы не оставлять его висеть. */
  private async detachClient(): Promise<void> {
    const client = this.client
    this.client = null
    this.ready = false
    if (client === null) return
    try {
      await client.destroy()
    } catch {
      /* соединение уже закрыто */
    }
  }

  /**
   * Вход по QR — тот же способ, которым подключается Telegram Desktop.
   * Телеграм выдаёт короткоживущий ключ, мы рисуем из него картинку;
   * пользователь сканирует её в приложении на телефоне.
   * Библиотека сама обновляет ключ каждые несколько десятков секунд
   * и вызывает наш обработчик заново.
   */
  private startQrLoginInBackground(): void {
    void this.loginByQr().catch((err: unknown) => {
      this.logger.error({ err }, 'вход по QR не удался')
      this.emit('status', 'logged_out', {
        reason: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private async loginByQr(): Promise<void> {
    await this.detachClient()
    const client = new TelegramClient(
      new StringSession(''),
      config.TG_API_ID,
      config.TG_API_HASH,
      { connectionRetries: 5 },
    )
    client.setLogLevel?.('error')
    await client.connect()
    this.client = client

    const password = this.cloudPassword
    try {
      await client.signInUserWithQrCode(
        { apiId: config.TG_API_ID, apiHash: config.TG_API_HASH },
        {
          qrCode: async (code: { token: Buffer }) => {
            const token = code.token.toString('base64url')
            const dataUrl = await QRCode.toDataURL(`tg://login?token=${token}`, {
              margin: 1,
              width: 320,
            })
            this.emit('status', 'qr', {})
            this.emit('qr', dataUrl)
          },
          password: async () => {
            if (password === undefined) {
              throw new Error('нужен облачный пароль')
            }
            return password
          },
          onError: (err: Error) => {
            this.logger.error({ err }, 'ошибка входа по QR')
            return false
          },
        },
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes('облачный пароль')) {
        this.emit('status', 'logged_out', {
          reason: 'на аккаунте включён облачный пароль — укажите его при добавлении канала',
        })
        return
      }

      // Обрыв связи — не разлогин. Раньше любая сетевая заминка присылала
      // владельцу «номер разлогинен, сканируйте QR заново», хотя ничего
      // сканировать не требовалось.
      if (isTemporary(message)) {
        this.logger.warn({ err }, 'связь оборвалась во время входа, пробую снова')
        this.emit('status', 'offline', { reason: 'связь оборвалась, переподключаюсь' })
        if (!this.stopping) setTimeout(() => this.startQrLoginInBackground(), 5000)
        return
      }

      this.emit('status', 'logged_out', { reason: `вход не удался: ${message}` })
      return
    }

    if (this.stopping) return

    // Пароль больше не нужен: дальше вход держится на сохранённой сессии.
    this.cloudPassword = undefined
    await saveSession(this.channelId, client.session.save() as string)
    this.logger.info('вход по QR выполнен')

    // Дальше работаем ЭТИМ же соединением. Раньше здесь поднималось второе,
    // а первое оставалось висеть: два клиента на одной сессии мешали друг
    // другу, и обновления не приходили вовсе.
    await this.attach(client)
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

  /**
   * Ищет человека в Телеграме по номеру телефона.
   *
   * Два способа, и оба могут не сработать: человек вправе запретить
   * находить себя по номеру, и тогда написать ему первым нельзя никак.
   * Сначала пробуем спросить напрямую, и только потом — через добавление
   * в контакты: второй способ показывает наш номер собеседнику.
   */
  async findChatByPhone(
    phone: string,
    _name?: string,
    opts?: { deep?: boolean },
  ): Promise<string | null> {
    const client = this.client
    if (client === null || !this.ready) throw new Error(`Канал ${this.label} не в сети`)
    const digits = phone.replace(/\D/g, '')
    if (digits === '') return null

    try {
      const found = await client.invoke(new Api.contacts.ResolvePhone({ phone: digits }))
      const user = found?.users?.[0]
      if (user !== undefined) return String(user.id)
    } catch (err) {
      this.logger.info({ err: String(err).slice(0, 120) }, 'по номеру напрямую не нашёлся')
    }

    // Добавление в контакты Телеграм замечает особенно охотно. Делаем это
    // только когда менеджер сам решил написать человеку, и никогда — при
    // фоновой подготовке карточек.
    if (opts?.deep !== true) return null

    try {
      const imported = await client.invoke(
        new Api.contacts.ImportContacts({
          contacts: [
            new Api.InputPhoneContact({
              clientId: bigInt(0),
              phone: `+${digits}`,
              firstName: 'Клиент',
              lastName: '',
            }),
          ],
        }),
      )
      const user = imported?.users?.[0]
      return user === undefined ? null : String(user.id)
    } catch (err) {
      this.logger.warn({ err: String(err).slice(0, 200) }, 'поиск по номеру не удался')
      return null
    }
  }

  /**
   * Телеграм узнаёт собеседника по паре «номер плюс пропуск», а пропуск
   * живёт в памяти до перезапуска. Поэтому если он потерялся — находим
   * человека по телефону заново.
   */
  private async resolvePeer(externalChatId: string, phone: string | undefined): Promise<unknown> {
    const client = this.client
    try {
      return await client.getInputEntity(externalChatId)
    } catch (err) {
      if (phone === undefined || phone === '') throw err
      this.logger.info({ externalChatId }, 'собеседник забылся, ищу по телефону заново')
      const found = await this.findChatByPhone(phone)
      if (found === null) throw err
      return await client.getInputEntity(found)
    }
  }

  async send(out: OutboundMessage): Promise<string> {
    const client = this.client
    if (client === null || !this.ready) throw new Error(`Канал ${this.label} не в сети`)

    const peer = await this.resolvePeer(out.externalChatId, out.phone)
    const options: Record<string, unknown> = {}
    if (out.body !== '') options['message'] = out.body
    if (out.quotedExternalMessageId !== undefined) {
      options['replyTo'] = Number(out.quotedExternalMessageId)
    }
    if (out.mediaPath !== undefined) {
      // Ссылку Телеграму не даём: хранилище amoCRM закрыто для посторонних,
      // и он отвечает WEBPAGE_CURL_FAILED. Скачиваем файл сами.
      options['file'] = await outgoingLocalFile(this.channelId, out)
      // Голосовые Телеграм показывает кружком-дорожкой только с этим признаком.
      if (out.type === 'voice') options['voiceNote'] = true
      // Имя файла берём из amoCRM: иначе клиент получит «out-1758…pdf»
      // вместо «КП Жк Живописный, кв. 412.pdf».
      if (out.mediaName !== undefined && out.mediaName !== '' && out.type !== 'voice') {
        options['attributes'] = [new Api.DocumentAttributeFilename({ fileName: out.mediaName })]
      }
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
    this.stopping = true
    this.ready = false
    const client = this.client
    this.client = null
    if (client === null) return
    // destroy, а не disconnect: disconnect оставляет живым цикл обновлений,
    // и соединение продолжает висеть после остановки канала.
    void Promise.resolve(client.destroy()).catch(() => {
      /* соединение уже закрыто */
    })
  }

  /** Имя собеседника — используется при разборе входящих. */
  static displayName = displayName
}
