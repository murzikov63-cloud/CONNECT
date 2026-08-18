import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import { log } from '../logger/index.js'
import type { DeliveryStatus, InboundMessage, MediaPayload, NumberStatus, OutboundMessage } from '../types.js'
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
} from './baileys.js'
import type { WASocket } from './baileys.js'
import { usePostgresAuthState } from './auth-state.js'
import { absoluteMediaPath, saveMedia } from './media.js'
import { extractContent, normalizeInbound } from './normalize.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

/** Коды из proto.WebMessageInfo.Status. */
const STATUS_BY_CODE: Record<number, DeliveryStatus> = {
  1: 'sent',
  2: 'delivered',
  3: 'read',
  4: 'read',
}

export interface SessionEvents {
  status: [NumberStatus, { reason?: string; phone?: string }]
  qr: [string]
  inbound: [InboundMessage]
  delivery: [{ waMessageId: string; status: DeliveryStatus }]
}

/**
 * Одна сессия = один рабочий номер WhatsApp.
 * Сама переподключается; наружу отдаёт только события, записью в базу
 * занимается SessionManager.
 */
export class WaSession extends EventEmitter {
  readonly numberId: string
  readonly label: string

  private sock: WASocket | null = null
  private saveCreds: (() => Promise<void>) | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopping = false
  private readonly logger

  constructor(numberId: string, label: string) {
    super()
    this.numberId = numberId
    this.label = label
    this.logger = log('wa').child({ numberId, label })
  }

  get socket(): WASocket | null {
    return this.sock
  }

  async start(): Promise<void> {
    this.stopping = false
    this.emit('status', 'connecting', {})

    const { state, saveCreds } = await usePostgresAuthState(this.numberId)
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
      if (payload?.type !== 'notify') return
      for (const msg of payload.messages ?? []) {
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
        if (status !== undefined) this.emit('delivery', { waMessageId: id, status })
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
      this.emit('status', 'online', { phone })
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

  private async handleIncoming(msg: any): Promise<void> {
    const normalized = normalizeInbound(this.numberId, msg)
    if (normalized === null) return

    const content = extractContent(msg.message)
    if (content.mediaKind !== undefined) {
      const media = await this.downloadMedia(msg, normalized.waMessageId, content)
      if (media !== null) normalized.media = media
    }

    this.emit('inbound', normalized)
  }

  private async downloadMedia(
    msg: any,
    waMessageId: string,
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
        this.numberId,
        waMessageId,
        buffer,
        content.mediaMime ?? 'application/octet-stream',
        content.mediaName,
      )
    } catch (err) {
      this.logger.error({ err, waMessageId }, 'не удалось скачать вложение')
      return null
    }
  }

  /** Возвращает id отправленного сообщения в WhatsApp. */
  async send(out: OutboundMessage): Promise<string> {
    const sock = this.sock
    if (sock === null) throw new Error(`Сессия ${this.label} не поднята`)

    const content = this.buildContent(out)
    const options: Record<string, unknown> = {}
    if (out.quotedWaMessageId !== undefined) {
      options['quoted'] = {
        key: { remoteJid: out.chatJid, id: out.quotedWaMessageId, fromMe: false },
        message: { conversation: '' },
      }
    }

    // Печатающий статус перед отправкой — выглядит естественнее.
    try {
      await sock.sendPresenceUpdate('composing', out.chatJid)
    } catch {
      /* презенс не критичен */
    }

    const sent = await sock.sendMessage(out.chatJid, content as any, options as any)
    const id: string = (sent as any)?.key?.id ?? ''
    if (id === '') throw new Error('WhatsApp не вернул id отправленного сообщения')
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
