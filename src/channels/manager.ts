import { EventEmitter } from 'node:events'
import { alert } from '../alerts/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { getSettings, isPersonalNumber } from '../settings.js'
import { toInternationalPhone } from '../utils.js'
import type { DeliveryStatus, InboundMessage, ChannelStatus } from '../types.js'
import { clearAuthState } from '../wa/auth-state.js'
import { createDriver } from './registry.js'
import type { DriverOptions } from './registry.js'
import type { ChannelDriver, ChannelKind } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = log('manager')

/** Что драйвер сообщает вместе со сменой состояния. */
export interface StatusExtra {
  reason?: string
  phone?: string
  /** Идентификатор аккаунта в самом мессенджере. */
  externalId?: string
}

export interface ChannelRow {
  id: string
  kind: ChannelKind
  label: string
  phone: string | null
  external_id: string | null
  status: ChannelStatus
  last_connected_at: Date | null
  last_disconnect_reason: string | null
  created_at: Date
}

export interface ChatRow {
  id: string
  channel_id: string
  external_chat_id: string
  phone: string | null
  push_name: string | null
  avatar_url: string | null
  is_group: boolean
  ignored: boolean
  amo_chat_id: string | null
  amo_contact_id: string | null
  amo_lead_id: string | null
  first_outbound_at: Date | null
  last_message_at: Date | null
}

/**
 * Держит все сессии номеров, пишет их состояние в базу и шлёт алерты.
 * Наружу отдаёт событие `inbound` с уже сохранённым сообщением —
 * дальше его подхватывает очередь и коннектор amoCRM.
 */
export class ChannelManager extends EventEmitter {
  private readonly drivers = new Map<string, ChannelDriver>()

  /**
   * Сообщения, которые мы только что отправили сами.
   *
   * Мессенджер возвращает их нам эхом как «отправленные с этого аккаунта».
   * Без такой пометки ответ менеджера ушёл бы в карточку дважды: один раз
   * из amoCRM, второй — эхом из мессенджера. На уникальный индекс в базе
   * полагаться нельзя: эхо приходит за миллисекунды и может обогнать
   * запись идентификатора.
   */
  private readonly selfSent = new Map<string, number>()
  private static readonly SELF_SENT_TTL_MS = 10 * 60 * 1000

  /**
   * Отложенные оповещения об отвалившемся номере.
   *
   * Короткий разрыв — обычное дело: перезапуск службы, моргнувшая сеть.
   * Переподключение занимает секунды, и оповещение о нём — шум, из-за
   * которого перестают читать все остальные. Поэтому ждём: если через
   * минуту с небольшим номер всё ещё не в сети — вот тогда это авария.
   */
  private readonly offlineAlerts = new Map<string, NodeJS.Timeout>()
  private static readonly OFFLINE_ALERT_DELAY_MS = 90 * 1000

  markSelfSent(channelId: string, externalMessageId: string): void {
    const now = Date.now()
    this.selfSent.set(`${channelId}:${externalMessageId}`, now)
    // Заодно подчищаем старое, чтобы карта не росла бесконечно.
    for (const [key, at] of this.selfSent) {
      if (now - at > ChannelManager.SELF_SENT_TTL_MS) this.selfSent.delete(key)
    }
  }

  /** Публичный ради проверок: без этого поведение не покрыть тестом. */
  isSelfSent(channelId: string, externalMessageId: string, now: number = Date.now()): boolean {
    const key = `${channelId}:${externalMessageId}`
    const at = this.selfSent.get(key)
    if (at === undefined) return false
    if (now - at > ChannelManager.SELF_SENT_TTL_MS) {
      this.selfSent.delete(key)
      return false
    }
    return true
  }

  async bootstrap(): Promise<void> {
    const numbers = await sql<ChannelRow[]>`
      select * from channels
      where deleted_at is null and status <> 'banned'
      order by created_at
    `
    logger.info({ count: numbers.length }, 'поднимаю сохранённые каналы')
    for (const row of numbers) {
      try {
        await this.startChannel(row.id, row.kind, row.label)
      } catch (err) {
        // Один сломанный канал не должен мешать подняться остальным.
        logger.error({ err, channelId: row.id, kind: row.kind }, 'канал не поднялся')
      }
    }
  }

  async listNumbers(): Promise<ChannelRow[]> {
    return sql<ChannelRow[]>`
      select * from channels where deleted_at is null order by created_at
    `
  }

  async addChannel(
    kind: ChannelKind,
    label: string,
    options?: DriverOptions,
  ): Promise<ChannelRow> {
    const rows = await sql<ChannelRow[]>`
      insert into channels (kind, label) values (${kind}, ${label}) returning *
    `
    const row = rows[0]
    if (row === undefined) throw new Error('не удалось создать канал')
    await this.startChannel(row.id, row.kind, row.label, options)
    return row
  }

  async startChannel(
    id: string,
    kind?: ChannelKind,
    label?: string,
    options?: DriverOptions,
  ): Promise<void> {
    if (this.drivers.has(id)) return

    let resolvedKind = kind
    let resolvedLabel = label
    if (resolvedKind === undefined || resolvedLabel === undefined) {
      const rows = await sql<{ kind: ChannelKind; label: string }[]>`
        select kind, label from channels where id = ${id}
      `
      const row = rows[0]
      if (row === undefined) throw new Error('канал не найден')
      resolvedKind ??= row.kind
      resolvedLabel ??= row.label
    }

    const driver = createDriver(resolvedKind, id, resolvedLabel, options)
    this.drivers.set(id, driver)
    this.wire(driver, resolvedLabel)
    await driver.start()
  }

  async restartChannel(id: string): Promise<void> {
    this.drivers.get(id)?.stop()
    this.drivers.delete(id)
    await this.startChannel(id)
  }

  /** Отвязывает номер в WhatsApp, чистит ключи и помечает запись удалённой. */
  async removeChannel(id: string): Promise<void> {
    const driver = this.drivers.get(id)
    if (driver !== undefined) {
      await driver.disconnect()
      driver.stop()
      this.drivers.delete(id)
    }
    await clearAuthState(id)
    await sql`
      update channels set status = 'new', deleted_at = now(), updated_at = now()
      where id = ${id}
    `
  }

  getDriver(id: string): ChannelDriver | undefined {
    return this.drivers.get(id)
  }

  /**
   * Заводит переписку с человеком, который нам ещё не писал, — по номеру
   * телефона. Так менеджер может написать первым: с заявки мы знаем только
   * номер, а мессенджер требует опознать собеседника.
   *
   * Возвращает null, если ни один номер нужного мессенджера не в сети или
   * такого человека там нет (или он запретил находить себя по номеру).
   */
  async openChatByPhone(
    kind: ChannelKind,
    phone: string,
    name: string,
  ): Promise<{ chat_id: string; channel_id: string; external_chat_id: string } | null> {
    const digits = toInternationalPhone(phone)
    if (digits === '') return null

    const channelId = [...this.drivers.entries()].find(
      ([, d]) => d.kind === kind && d.isReady() && d.findChatByPhone !== undefined,
    )?.[0]
    if (channelId === undefined) {
      logger.info({ kind }, 'подходящий номер не в сети')
      return null
    }

    const driver = this.drivers.get(channelId)
    const externalChatId = await driver?.findChatByPhone?.(digits).catch((err: unknown) => {
      logger.error({ err, kind }, 'поиск собеседника по номеру не удался')
      return null
    })
    if (externalChatId === null || externalChatId === undefined || externalChatId === '') {
      logger.info({ kind, phone: digits }, 'в этом мессенджере такого номера нет')
      return null
    }

    const rows = await sql<{ id: string }[]>`
      insert into chats (channel_id, external_chat_id, phone, push_name)
      values (${channelId}, ${externalChatId}, ${digits}, ${name === '' ? null : name})
      on conflict (channel_id, external_chat_id) do update set
        phone = coalesce(chats.phone, excluded.phone),
        push_name = coalesce(chats.push_name, excluded.push_name),
        updated_at = now()
      returning id::text as id
    `
    const chatId = rows[0]?.id
    if (chatId === undefined) return null

    logger.info({ kind, chatId, externalChatId }, 'переписка заведена по номеру телефона')
    return { chat_id: chatId, channel_id: channelId, external_chat_id: externalChatId }
  }

  async getQr(id: string): Promise<string | null> {
    const rows = await sql<{ last_qr: string | null }[]>`
      select last_qr from channels where id = ${id}
    `
    return rows[0]?.last_qr ?? null
  }

  private wire(driver: ChannelDriver, label: string): void {
    const channelId = driver.channelId
    const session = driver

    session.on('status', (status: ChannelStatus, extra: StatusExtra) => {
      void this.onStatus(channelId, label, status, extra).catch((err: unknown) =>
        logger.error({ err, channelId }, 'ошибка обработки статуса'),
      )
    })

    session.on('qr', (dataUrl: string) => {
      void sql`
        update channels set last_qr = ${dataUrl}, last_qr_at = now(), updated_at = now()
        where id = ${channelId}
      `.catch((err: unknown) => logger.error({ err, channelId }, 'не удалось сохранить QR'))
    })

    session.on('inbound', (msg: InboundMessage) => {
      void this.onInbound(msg).catch((err: unknown) =>
        logger.error({ err, channelId }, 'ошибка сохранения входящего'),
      )
    })

    session.on('delivery', (u: { externalMessageId: string; status: DeliveryStatus }) => {
      void this.onDelivery(channelId, u).catch((err: unknown) =>
        logger.error({ err, channelId }, 'ошибка обновления статуса доставки'),
      )
    })
  }

  private async onStatus(
    channelId: string,
    label: string,
    status: ChannelStatus,
    extra: StatusExtra,
  ): Promise<void> {
    await sql`
      update channels set
        status = ${status},
        phone = coalesce(${extra.phone ?? null}, phone),
        external_id = coalesce(${extra.externalId ?? null}, external_id),
        last_connected_at = case when ${status} = 'online' then now() else last_connected_at end,
        last_qr = case when ${status} = 'online' then null else last_qr end,
        last_disconnect_reason = ${extra.reason ?? null},
        updated_at = now()
      where id = ${channelId}
    `

    if (status !== 'offline') {
      const pending = this.offlineAlerts.get(channelId)
      if (pending !== undefined) {
        clearTimeout(pending)
        this.offlineAlerts.delete(channelId)
      }
    }

    if (status === 'logged_out') {
      await clearAuthState(channelId)
      await alert('error', `Номер «${label}» разлогинен`, {
        Причина: extra.reason ?? '—',
        Действие: 'нужно заново отсканировать QR в админке',
      })
    } else if (status === 'banned') {
      await alert('error', `Номер «${label}» заблокирован WhatsApp`, {
        Причина: extra.reason ?? '—',
        Действие: 'переводим переписку на резервный номер',
      })
    } else if (status === 'offline') {
      this.scheduleOfflineAlert(channelId, label, extra.reason)
    } else if (status === 'online') {
      logger.info({ channelId, phone: extra.phone }, 'номер в сети')
    }
  }

  /** Оповещает об отвалившемся номере, только если он не вернулся сам. */
  private scheduleOfflineAlert(channelId: string, label: string, reason?: string): void {
    if (this.offlineAlerts.has(channelId)) return

    const timer = setTimeout(() => {
      this.offlineAlerts.delete(channelId)
      void (async () => {
        const rows = await sql<{ status: ChannelStatus }[]>`
          select status from channels where id = ${channelId}
        `
        if (rows[0]?.status !== 'offline') return
        await alert('warn', `Номер «${label}» не в сети`, {
          Причина: reason ?? '—',
          'Не в сети': 'больше полутора минут, переподключение продолжается',
        })
      })().catch((err: unknown) => logger.error({ err, channelId }, 'не удалось оповестить'))
    }, ChannelManager.OFFLINE_ALERT_DELAY_MS)

    // Таймер не должен удерживать процесс при остановке сервиса.
    timer.unref()
    this.offlineAlerts.set(channelId, timer)
  }

  private async onInbound(msg: InboundMessage): Promise<void> {
    const settings = await getSettings()

    if (msg.isGroup && settings.ignoreGroups) return
    if (isPersonalNumber(settings, msg.phone)) return

    // Эхо нашей же отправки: сообщение уже есть и в базе, и в amoCRM.
    if (msg.fromMe && this.isSelfSent(msg.channelId, msg.externalMessageId)) {
      logger.debug({ externalMessageId: msg.externalMessageId }, 'эхо своей отправки, пропускаю')
      return
    }

    const chat = await this.upsertChat(msg)
    if (chat.ignored) return

    // Дедупликация: at-least-once на очереди + уникальный индекс здесь
    // гарантируют, что повторная доставка не создаст второе сообщение.
    const inserted = await sql<{ id: string }[]>`
      insert into messages (
        channel_id, chat_id, external_message_id, direction, type, body,
        media_path, media_mime, media_name, media_size,
        quoted_external_message_id, sender_name, status, occurred_at
      ) values (
        ${msg.channelId}, ${chat.id}, ${msg.externalMessageId},
        ${msg.fromMe ? 'out' : 'in'}, ${msg.type}, ${msg.body},
        ${msg.media?.path ?? null}, ${msg.media?.mime ?? null},
        ${msg.media?.name ?? null}, ${msg.media?.size ?? null},
        ${msg.quotedExternalMessageId ?? null}, ${msg.pushName},
        ${msg.fromMe ? 'sent' : 'received'}, ${msg.occurredAt}
      )
      on conflict do nothing
      returning id
    `
    const row = inserted[0]
    if (row === undefined) {
      logger.debug({ externalMessageId: msg.externalMessageId }, 'дубль, пропускаю')
      return
    }

    this.emit('inbound', { ...msg, dbId: row.id, chat })
  }

  private async upsertChat(msg: InboundMessage): Promise<ChatRow> {
    const rows = await sql<ChatRow[]>`
      insert into chats (channel_id, external_chat_id, phone, push_name, is_group, last_message_at)
      values (
        ${msg.channelId}, ${msg.externalChatId}, ${msg.phone === '' ? null : msg.phone},
        ${msg.pushName === '' ? null : msg.pushName}, ${msg.isGroup}, ${msg.occurredAt}
      )
      on conflict (channel_id, external_chat_id) do update set
        push_name = coalesce(nullif(excluded.push_name, ''), chats.push_name),
        last_message_at = greatest(coalesce(chats.last_message_at, excluded.last_message_at), excluded.last_message_at),
        updated_at = now()
      returning *
    `
    const chat = rows[0]
    if (chat === undefined) throw new Error('не удалось создать чат')

    if (chat.avatar_url == null && !msg.isGroup) {
      void this.fetchAvatar(msg.channelId, msg.externalChatId)
    }
    return chat
  }

  /** Аватар подтягиваем в фоне — он не должен задерживать доставку сообщения. */
  private fetchAvatar(channelId: string, externalChatId: string): void {
    const driver = this.drivers.get(channelId)
    if (driver?.fetchAvatar === undefined) return
    void driver
      .fetchAvatar(externalChatId)
      .then(async (url) => {
        if (url === null) return
        await sql`
          update chats set avatar_url = ${url}
          where channel_id = ${channelId} and external_chat_id = ${externalChatId}
        `
      })
      .catch(() => {
        /* аватара может не быть или он закрыт настройками приватности */
      })
  }

  private async onDelivery(
    channelId: string,
    u: { externalMessageId: string; status: DeliveryStatus },
  ): Promise<void> {
    const column =
      u.status === 'delivered' ? 'delivered_at' : u.status === 'read' ? 'read_at' : 'sent_at'

    await sql`
      update messages set
        status = ${u.status},
        ${sql(column)} = coalesce(${sql(column)}, now())
      where channel_id = ${channelId} and external_message_id = ${u.externalMessageId} and direction = 'out'
    `
    this.emit('delivery', { channelId, ...u })
  }

  async shutdown(): Promise<void> {
    logger.info('останавливаю сессии')
    for (const driver of this.drivers.values()) driver.stop()
    this.drivers.clear()
  }
}
