import { EventEmitter } from 'node:events'
import { alert } from '../alerts/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { getSettings, isPersonalNumber } from '../settings.js'
import type { DeliveryStatus, InboundMessage, NumberStatus } from '../types.js'
import { clearAuthState } from './auth-state.js'
import { WaSession } from './session.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = log('manager')

export interface NumberRow {
  id: string
  label: string
  phone: string | null
  jid: string | null
  status: NumberStatus
  last_connected_at: Date | null
  last_disconnect_reason: string | null
  created_at: Date
}

export interface ChatRow {
  id: string
  number_id: string
  chat_jid: string
  phone: string | null
  push_name: string | null
  is_group: boolean
  ignored: boolean
  amo_chat_id: string | null
  amo_contact_id: string | null
  amo_lead_id: string | null
  first_outbound_at: Date | null
}

/**
 * Держит все сессии номеров, пишет их состояние в базу и шлёт алерты.
 * Наружу отдаёт событие `inbound` с уже сохранённым сообщением —
 * дальше его подхватывает очередь и коннектор amoCRM.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, WaSession>()

  async bootstrap(): Promise<void> {
    const numbers = await sql<NumberRow[]>`
      select * from wa_numbers
      where deleted_at is null and status <> 'banned'
      order by created_at
    `
    logger.info({ count: numbers.length }, 'поднимаю сохранённые номера')
    for (const row of numbers) {
      await this.startNumber(row.id, row.label)
    }
  }

  async listNumbers(): Promise<NumberRow[]> {
    return sql<NumberRow[]>`
      select * from wa_numbers where deleted_at is null order by created_at
    `
  }

  async addNumber(label: string): Promise<NumberRow> {
    const rows = await sql<NumberRow[]>`
      insert into wa_numbers (label) values (${label}) returning *
    `
    const row = rows[0]
    if (row === undefined) throw new Error('не удалось создать номер')
    await this.startNumber(row.id, row.label)
    return row
  }

  async startNumber(id: string, label?: string): Promise<void> {
    if (this.sessions.has(id)) return
    const name =
      label ??
      (
        await sql<{ label: string }[]>`select label from wa_numbers where id = ${id}`
      )[0]?.label ??
      id

    const session = new WaSession(id, name)
    this.sessions.set(id, session)
    this.wire(session)
    await session.start()
  }

  async restartNumber(id: string): Promise<void> {
    this.sessions.get(id)?.stop()
    this.sessions.delete(id)
    await this.startNumber(id)
  }

  /** Отвязывает номер в WhatsApp, чистит ключи и помечает запись удалённой. */
  async removeNumber(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session !== undefined) {
      await session.logout()
      session.stop()
      this.sessions.delete(id)
    }
    await clearAuthState(id)
    await sql`
      update wa_numbers set status = 'new', deleted_at = now(), updated_at = now()
      where id = ${id}
    `
  }

  getSession(id: string): WaSession | undefined {
    return this.sessions.get(id)
  }

  async getQr(id: string): Promise<string | null> {
    const rows = await sql<{ last_qr: string | null }[]>`
      select last_qr from wa_numbers where id = ${id}
    `
    return rows[0]?.last_qr ?? null
  }

  private wire(session: WaSession): void {
    const { numberId, label } = session

    session.on('status', (status: NumberStatus, extra: { reason?: string; phone?: string }) => {
      void this.onStatus(numberId, label, status, extra).catch((err: unknown) =>
        logger.error({ err, numberId }, 'ошибка обработки статуса'),
      )
    })

    session.on('qr', (dataUrl: string) => {
      void sql`
        update wa_numbers set last_qr = ${dataUrl}, last_qr_at = now(), updated_at = now()
        where id = ${numberId}
      `.catch((err: unknown) => logger.error({ err, numberId }, 'не удалось сохранить QR'))
    })

    session.on('inbound', (msg: InboundMessage) => {
      void this.onInbound(msg).catch((err: unknown) =>
        logger.error({ err, numberId }, 'ошибка сохранения входящего'),
      )
    })

    session.on('delivery', (u: { waMessageId: string; status: DeliveryStatus }) => {
      void this.onDelivery(numberId, u).catch((err: unknown) =>
        logger.error({ err, numberId }, 'ошибка обновления статуса доставки'),
      )
    })
  }

  private async onStatus(
    numberId: string,
    label: string,
    status: NumberStatus,
    extra: { reason?: string; phone?: string },
  ): Promise<void> {
    await sql`
      update wa_numbers set
        status = ${status},
        phone = coalesce(${extra.phone ?? null}, phone),
        jid = coalesce(${extra.phone !== undefined ? `${extra.phone}@s.whatsapp.net` : null}, jid),
        last_connected_at = case when ${status} = 'online' then now() else last_connected_at end,
        last_qr = case when ${status} = 'online' then null else last_qr end,
        last_disconnect_reason = ${extra.reason ?? null},
        updated_at = now()
      where id = ${numberId}
    `

    if (status === 'logged_out') {
      await clearAuthState(numberId)
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
      await alert('warn', `Номер «${label}» отвалился`, {
        Причина: extra.reason ?? '—',
        Действие: 'переподключаюсь автоматически',
      })
    } else if (status === 'online') {
      logger.info({ numberId, phone: extra.phone }, 'номер в сети')
    }
  }

  private async onInbound(msg: InboundMessage): Promise<void> {
    const settings = await getSettings()

    if (msg.isGroup && settings.ignoreGroups) return
    if (isPersonalNumber(settings, msg.phone)) return

    const chat = await this.upsertChat(msg)
    if (chat.ignored) return

    // Дедупликация: at-least-once на очереди + уникальный индекс здесь
    // гарантируют, что повторная доставка не создаст второе сообщение.
    const inserted = await sql<{ id: string }[]>`
      insert into messages (
        number_id, chat_id, wa_message_id, direction, type, body,
        media_path, media_mime, media_name, media_size,
        quoted_wa_message_id, sender_name, status, occurred_at
      ) values (
        ${msg.numberId}, ${chat.id}, ${msg.waMessageId},
        ${msg.fromMe ? 'out' : 'in'}, ${msg.type}, ${msg.body},
        ${msg.media?.path ?? null}, ${msg.media?.mime ?? null},
        ${msg.media?.name ?? null}, ${msg.media?.size ?? null},
        ${msg.quotedWaMessageId ?? null}, ${msg.pushName},
        ${msg.fromMe ? 'sent' : 'received'}, ${msg.occurredAt}
      )
      on conflict do nothing
      returning id
    `
    const row = inserted[0]
    if (row === undefined) {
      logger.debug({ waMessageId: msg.waMessageId }, 'дубль, пропускаю')
      return
    }

    this.emit('inbound', { ...msg, dbId: row.id, chat })
  }

  private async upsertChat(msg: InboundMessage): Promise<ChatRow> {
    const rows = await sql<ChatRow[]>`
      insert into chats (number_id, chat_jid, phone, push_name, is_group, last_message_at)
      values (
        ${msg.numberId}, ${msg.chatJid}, ${msg.phone === '' ? null : msg.phone},
        ${msg.pushName === '' ? null : msg.pushName}, ${msg.isGroup}, ${msg.occurredAt}
      )
      on conflict (number_id, chat_jid) do update set
        push_name = coalesce(nullif(excluded.push_name, ''), chats.push_name),
        last_message_at = greatest(coalesce(chats.last_message_at, excluded.last_message_at), excluded.last_message_at),
        updated_at = now()
      returning *
    `
    const chat = rows[0]
    if (chat === undefined) throw new Error('не удалось создать чат')

    if (chat.avatar_url == null && !msg.isGroup) {
      void this.fetchAvatar(msg.numberId, msg.chatJid)
    }
    return chat
  }

  /** Аватар подтягиваем в фоне — он не должен задерживать доставку сообщения. */
  private fetchAvatar(numberId: string, chatJid: string): void {
    const sock = this.sessions.get(numberId)?.socket as any
    if (sock == null) return
    void sock
      .profilePictureUrl(chatJid, 'image')
      .then(
        (url: string | undefined) =>
          url !== undefined &&
          sql`update chats set avatar_url = ${url} where number_id = ${numberId} and chat_jid = ${chatJid}`,
      )
      .catch(() => {
        /* у контакта может не быть аватара или закрыты настройки приватности */
      })
  }

  private async onDelivery(
    numberId: string,
    u: { waMessageId: string; status: DeliveryStatus },
  ): Promise<void> {
    const column =
      u.status === 'delivered' ? 'delivered_at' : u.status === 'read' ? 'read_at' : 'sent_at'

    await sql`
      update messages set
        status = ${u.status},
        ${sql(column)} = coalesce(${sql(column)}, now())
      where number_id = ${numberId} and wa_message_id = ${u.waMessageId} and direction = 'out'
    `
    this.emit('delivery', { numberId, ...u })
  }

  async shutdown(): Promise<void> {
    logger.info('останавливаю сессии')
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
  }
}
