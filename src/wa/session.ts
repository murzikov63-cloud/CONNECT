import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import type { DeliveryStatus, InboundMessage, MediaPayload, ChannelStatus, OutboundMessage } from '../types.js'
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
} from './baileys.js'
import type { WASocket } from './baileys.js'
import { CAPABILITIES } from '../channels/types.js'
import { usePostgresAuthState } from './auth-state.js'
import { absoluteMediaPath, saveMedia } from './media.js'
import { extractContent, lidOf, normalizeInbound, realJid } from './normalize.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

/** Коды из proto.WebMessageInfo.Status. */
/**
 * Числа, которыми WhatsApp обозначает судьбу сообщения. Взяты из самой
 * библиотеки (`WebMessageInfo.Status`), а не подобраны: ошибка на единицу
 * здесь означает, что менеджер видит «прочитано», когда клиент даже
 * не открывал переписку.
 *
 *   0 — ошибка, 1 — в пути, 2 — принято сервером,
 *   3 — доставлено собеседнику, 4 — прочитано, 5 — голосовое прослушано.
 */
const STATUS_BY_CODE: Record<number, DeliveryStatus> = {
  1: 'sent',
  2: 'sent',
  3: 'delivered',
  4: 'read',
  5: 'read',
}

export interface SessionEvents {
  status: [ChannelStatus, { reason?: string; phone?: string }]
  qr: [string]
  inbound: [InboundMessage]
  delivery: [{ externalMessageId: string; status: DeliveryStatus }]
}

/**
 * Одна сессия = один рабочий номер WhatsApp.
 * Сама переподключается; наружу отдаёт только события, записью в базу
 * занимается SessionManager.
 */
export class WaSession extends EventEmitter {
  readonly channelId: string
  readonly label: string

  private sock: WASocket | null = null
  private saveCreds: (() => Promise<void>) | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopping = false
  private readonly logger

  constructor(channelId: string, label: string) {
    super()
    this.channelId = channelId
    this.label = label
    this.logger = log('wa').child({ channelId, label })
  }

  get socket(): WASocket | null {
    return this.sock
  }

  async start(): Promise<void> {
    this.stopping = false
    this.emit('status', 'connecting', {})

    const { state, saveCreds } = await usePostgresAuthState(this.channelId)
    this.saveCreds = saveCreds

    const { version } = await fetchLatestBaileysVersion()
    this.logger.info({ waVersion: version.join('.') }, 'поднимаю сессию')

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Ответ на просьбу прислать сообщение заново. Когда телефон
      // собеседника не смог расшифровать наше сообщение, он просит
      // отправить его повторно — и без этого обработчика оно навсегда
      // остаётся у него надписью «Ожидание сообщения». Проверено живьём
      // на свежеподключённом номере.
      getMessage: async (key: { id?: string | null }) => this.recallSent(key?.id ?? ''),
      // Начальные запросы к WhatsApp иногда не укладываются в минуту,
      // и подключение остаётся недоделанным.
      defaultQueryTimeoutMs: 120_000,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ['Messenger', 'Chrome', '121.0.0'],
      logger: this.logger,
    })
    this.sock = sock

    sock.ev.on('creds.update', () => {
      void saveCreds().catch((err: unknown) => {
        this.logger.error({ err }, 'не удалось сохранить ключи сессии')
      })
    })

    sock.ev.on('connection.update', (update: any) => {
      this.handleConnectionUpdate(update)
    })

    sock.ev.on('messages.upsert', (payload: any) => {
      const вид = payload?.type
      // «notify» — новое сообщение в переписке. «append» — то, что мы
      // отправили сами с телефона или из веб-версии WhatsApp: менеджер
      // вполне может ответить клиенту мимо amoCRM, и такие сообщения
      // тоже должны быть в карточке, иначе там половина разговора.
      if (вид !== 'notify' && вид !== 'append') return

      for (const msg of payload.messages ?? []) {
        if (вид === 'append' && !this.свежееСвоё(msg)) continue
        void this.handleIncoming(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'ошибка обработки входящего')
        })
      }
    })

    sock.ev.on('messages.update', (updates: any[]) => {
      for (const u of updates ?? []) {
        const code = u?.update?.status
        const id = u?.key?.id
        if (typeof code !== 'number' || typeof id !== 'string') continue
        const status = STATUS_BY_CODE[code]
        if (status !== undefined) this.emit('delivery', { externalMessageId: id, status })
      }
    })
  }

  private handleConnectionUpdate(update: any): void {
    const { connection, lastDisconnect, qr } = update

    if (typeof qr === 'string') {
      void QRCode.toDataURL(qr, { margin: 1, width: 320 })
        .then((dataUrl) => {
          this.emit('status', 'qr', {})
          this.emit('qr', dataUrl)
        })
        .catch((err: unknown) => this.logger.error({ err }, 'не удалось отрисовать QR'))
    }

    if (connection === 'open') {
      this.reconnectAttempt = 0
      const rawId: string = this.sock?.user?.id ?? ''
      const phone = (rawId.split(':')[0] ?? '').replace(/\D/g, '')
      this.logger.info({ phone }, 'сессия онлайн')
      this.emit('status', 'online', { phone, externalId: rawId })
      return
    }

    if (connection !== 'close') return

    const statusCode: number | undefined = lastDisconnect?.error?.output?.statusCode
    const reason = this.describeDisconnect(statusCode)
    this.logger.warn({ statusCode, reason }, 'соединение закрыто')

    // 401 — номер отвязали в телефоне, ключи больше не годятся.
    if (statusCode === DisconnectReason['loggedOut']) {
      this.emit('status', 'logged_out', { reason })
      return
    }
    // 403 — WhatsApp заблокировал номер.
    if (statusCode === 403) {
      this.emit('status', 'banned', { reason })
      return
    }

    this.emit('status', 'offline', { reason })
    if (!this.stopping) this.scheduleReconnect()
  }

  private describeDisconnect(code: number | undefined): string {
    if (code === undefined) return 'причина неизвестна'
    const named = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0]
    return named !== undefined ? `${named} (${code})` : `код ${code}`
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS)
    this.reconnectAttempt++
    this.logger.info({ delay, attempt: this.reconnectAttempt }, 'переподключение')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start().catch((err: unknown) => {
        this.logger.error({ err }, 'переподключение не удалось')
        this.scheduleReconnect()
      })
    }, delay)
  }

  /**
   * Своё ли это сообщение и достаточно ли оно свежее.
   *
   * В той же куче WhatsApp присылает и старую переписку, когда
   * синхронизирует историю. Без проверки по времени в карточку клиента
   * хлынули бы разговоры недельной давности.
   */
  private свежееСвоё(msg: any): boolean {
    if (msg?.key?.fromMe !== true) return false
    const raw = msg?.messageTimestamp
    const seconds = Number(raw?.low ?? raw ?? 0)
    if (seconds <= 0) return false
    return seconds * 1000 > Date.now() - WaSession.APPEND_MAX_AGE_MS
  }

  /** Насколько старое «своё» сообщение ещё считаем сегодняшним разговором. */
  private static readonly APPEND_MAX_AGE_MS = 10 * 60 * 1000

  /**
   * Соответствие внутреннего номера WhatsApp телефонному адресу.
   *
   * В сообщениях клиента WhatsApp присылает оба, а в наших собственных,
   * отправленных с телефона или из веб-версии, — только внутренний.
   * Поэтому пары запоминаем, как только увидим; после перезапуска берём
   * из базы.
   */
  private readonly внутренниеНомера = new Map<string, string>()

  private async адресПереписки(key: any): Promise<string> {
    const прямой = realJid(key)
    const внутренний = lidOf(key)

    if (прямой !== '') {
      if (внутренний !== '') this.внутренниеНомера.set(внутренний, прямой)
      return прямой
    }
    if (внутренний === '') return ''

    const изПамяти = this.внутренниеНомера.get(внутренний)
    if (изПамяти !== undefined) return изПамяти

    const rows = await sql<{ external_chat_id: string }[]>`
      select external_chat_id from chats
      where channel_id = ${this.channelId} and external_alt_id = ${внутренний}
      limit 1
    `
    const изБазы = rows[0]?.external_chat_id
    if (изБазы === undefined) return ''
    this.внутренниеНомера.set(внутренний, изБазы)
    return изБазы
  }

  private async handleIncoming(msg: any): Promise<void> {
    const адрес = await this.адресПереписки(msg?.key)
    const normalized = normalizeInbound(this.channelId, msg, адрес === '' ? undefined : адрес)
    if (normalized === null) {
      if (msg?.key?.fromMe === true) {
        this.logger.info(
          { внутренний: lidOf(msg?.key) },
          'не знаю, кому писали: внутренний номер WhatsApp ещё не встречался',
        )
      }
      return
    }

    const content = extractContent(msg.message)
    if (content.mediaKind !== undefined) {
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
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.logger,
          reuploadRequest: (this.sock as any)?.updateMediaMessage,
        },
      )
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

  /** Возвращает id отправленного сообщения в WhatsApp. */
  /**
   * Проверяет, есть ли такой номер в WhatsApp, и возвращает его адрес.
   * Нужно для первого сообщения тому, кто нам ещё не писал: слать вслепую
   * нельзя — попытки писать несуществующим номерам WhatsApp считает
   * признаком рассылки.
   */
  async findChatByPhone(phone: string): Promise<string | null> {
    const sock = this.sock
    const digits = phone.replace(/\D/g, '')
    if (sock === null || !this.isReady() || digits === '') return null
    const found = await sock.onWhatsApp(digits)
    const first = found?.[0]
    return first?.exists === true ? String(first.jid) : null
  }

  /**
   * Что мы недавно отправили — на случай, если собеседник попросит
   * прислать заново. Держим в памяти немного и коротко: просьба приходит
   * в первые секунды, а не через день.
   */
  private readonly sent = new Map<string, unknown>()
  private static readonly SENT_KEEP = 300

  private remember(id: string, content: unknown): void {
    if (id === '') return
    this.sent.set(id, content)
    if (this.sent.size > WaSession.SENT_KEEP) {
      const oldest = this.sent.keys().next().value
      if (oldest !== undefined) this.sent.delete(oldest)
    }
  }

  /** Достаёт отправленное: сперва из памяти, потом из базы — там текст. */
  private async recallSent(id: string): Promise<{ conversation: string } | undefined> {
    if (id === '') return undefined
    const kept = this.sent.get(id)
    if (kept !== undefined) return kept as { conversation: string }

    // После перезапуска память пуста, но текст сообщения есть у нас в базе.
    const rows = await sql<{ body: string | null }[]>`
      select body from messages
      where channel_id = ${this.channelId} and external_message_id = ${id}
      limit 1
    `
    const body = rows[0]?.body
    return body == null || body === '' ? undefined : { conversation: body }
  }

  async send(out: OutboundMessage): Promise<string> {
    const sock = this.sock
    if (sock === null) throw new Error(`Сессия ${this.label} не поднята`)

    const content = this.buildContent(out)
    const options: Record<string, unknown> = {}
    if (out.quotedExternalMessageId !== undefined) {
      options['quoted'] = {
        key: { remoteJid: out.externalChatId, id: out.quotedExternalMessageId, fromMe: false },
        message: { conversation: '' },
      }
    }

    // Печатающий статус перед отправкой — выглядит естественнее.
    try {
      await sock.sendPresenceUpdate('composing', out.externalChatId)
    } catch {
      /* презенс не критичен */
    }

    const sent = await sock.sendMessage(out.externalChatId, content as any, options as any)
    const id: string = (sent as any)?.key?.id ?? ''
    if (id === '') throw new Error('WhatsApp не вернул id отправленного сообщения')
    // Запоминаем на случай просьбы прислать заново.
    this.remember(id, (sent as any)?.message)
    return id
  }

  private buildContent(out: OutboundMessage): Record<string, unknown> {
    const source =
      out.mediaPath === undefined
        ? undefined
        : out.mediaPath.startsWith('http')
          ? { url: out.mediaPath }
          : { url: absoluteMediaPath(out.mediaPath) }

    switch (out.type) {
      case 'image':
        return { image: source, caption: out.body }
      case 'video':
        return { video: source, caption: out.body }
      case 'voice':
        return { audio: source, mimetype: 'audio/mp4', ptt: true }
      case 'audio':
        return { audio: source, mimetype: out.mediaMime ?? 'audio/mp4', ptt: false }
      case 'document':
        return {
          document: source,
          mimetype: out.mediaMime ?? 'application/octet-stream',
          fileName: out.mediaName ?? 'file',
          caption: out.body,
        }
      default:
        return { text: out.body }
    }
  }

  /** Аватар контакта. Может отсутствовать или быть закрыт настройками. */
  async fetchAvatar(externalChatId: string): Promise<string | null> {
    const sock = this.sock as any
    if (sock == null) return null
    try {
      return ((await sock.profilePictureUrl(externalChatId, 'image')) as string | undefined) ?? null
    } catch {
      return null
    }
  }

  /** Отвязывает номер в WhatsApp — после этого нужен новый QR. */
  async disconnect(): Promise<void> {
    await this.logout()
  }

  isReady(): boolean {
    return this.sock !== null
  }

  readonly kind = 'whatsapp' as const
  readonly capabilities = CAPABILITIES.whatsapp

  async logout(): Promise<void> {
    this.stopping = true
    try {
      await this.sock?.logout()
    } catch {
      /* уже отвалилась */
    }
    this.sock = null
  }

  stop(): void {
    this.stopping = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.sock?.end(undefined)
    } catch {
      /* сокет уже закрыт */
    }
    this.sock = null
    this.saveCreds = null
  }
}
