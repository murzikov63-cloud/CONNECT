import cors from '@fastify/cors'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { config } from '../config/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { outboundQueue } from '../queue/index.js'
import { getSettings, saveSettings } from '../settings.js'
import type { ChannelManager } from '../channels/manager.js'
import { absoluteMediaPath, verifyMediaToken } from '../wa/media.js'
import { isKnownKind } from '../channels/registry.js'
import { CAPABILITIES, CHANNEL_TITLES } from '../channels/types.js'
import { openapi } from './openapi.js'
import {
  checkPassword,
  issueToken,
  loginBlocked,
  parseCorsOrigins,
  registerFailure,
  registerSuccess,
  verifyToken,
} from './auth.js'

const logger = log('api')
const startedAt = Date.now()

const settingsSchema = z
  .object({
    personalNumbers: z.array(z.string()).max(200),
    ignoreGroups: z.boolean(),
    newChatsPerNumberPerDay: z.number().int().min(0).max(1000),
    newChatDelayMinMs: z.number().int().min(0).max(120_000),
    newChatDelayMaxMs: z.number().int().min(0).max(120_000),
    replyDelayMinMs: z.number().int().min(0).max(60_000),
    replyDelayMaxMs: z.number().int().min(0).max(60_000),
    amoPipelineId: z.number().int().nullable(),
    amoStatusId: z.number().int().nullable(),
  })
  .partial()

export async function buildServer(manager: ChannelManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 })

  const origins = parseCorsOrigins(config.ADMIN_CORS_ORIGIN)
  await app.register(cors, {
    origin: origins.length === 0 ? false : origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  })

  /** Пускает по постоянному ключу (скрипты) или по токену входа (админка). */
  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = req.headers['x-api-key']
    if (typeof key === 'string' && key === config.ADMIN_API_KEY) return

    const header = req.headers.authorization ?? ''
    if (header.startsWith('Bearer ') && verifyToken(header.slice(7))) return

    await reply.code(401).send({ error: 'нужен вход' })
  }
  const guarded = { preHandler: auth }

  // --- открытые ручки ---------------------------------------------------

  // Для внешнего мониторинга: минимум сведений, без авторизации.
  app.get('/health', async () => ({
    ok: true,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }))

  app.get('/api/openapi.json', async () => openapi)

  /** Какие мессенджеры поддерживает платформа и как каждый подключается. */
  app.get('/api/channel-kinds', guarded, async () =>
    Object.entries(CAPABILITIES).map(([kind, caps]) => ({
      kind,
      title: CHANNEL_TITLES[kind as keyof typeof CHANNEL_TITLES],
      available: kind === 'whatsapp' || kind === 'telegram',
      ...caps,
    })),
  )

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const ip = req.headers['cf-connecting-ip']?.toString() ?? req.ip
    if (loginBlocked(ip)) {
      return reply.code(429).send({ error: 'слишком много попыток, подождите 15 минут' })
    }
    if (!checkPassword(req.body?.password ?? '')) {
      registerFailure(ip)
      logger.warn({ ip }, 'неудачная попытка входа')
      return reply.code(401).send({ error: 'неверный пароль' })
    }
    registerSuccess(ip)
    return issueToken()
  })

  // --- номера -----------------------------------------------------------

  app.get('/api/numbers', guarded, async () => {
    const numbers = await manager.listNumbers()
    const stats = await sql<
      { channel_id: string; incoming: string; outgoing: string; failed: string }[]
    >`
      select channel_id,
             count(*) filter (where direction = 'in')                as incoming,
             count(*) filter (where direction = 'out')               as outgoing,
             count(*) filter (where status = 'failed')               as failed
      from messages
      where created_at > now() - interval '24 hours'
      group by channel_id
    `
    const byId = new Map(stats.map((s) => [s.channel_id, s]))

    return numbers.map((n) => {
      const s = byId.get(n.id)
      return {
        id: n.id,
        kind: n.kind,
        kindTitle: CHANNEL_TITLES[n.kind] ?? n.kind,
        label: n.label,
        phone: n.phone,
        status: n.status,
        lastConnectedAt: n.last_connected_at,
        lastDisconnectReason: n.last_disconnect_reason,
        uptimeSec:
          n.status === 'online' && n.last_connected_at !== null
            ? Math.floor((Date.now() - new Date(n.last_connected_at).getTime()) / 1000)
            : 0,
        last24h: {
          incoming: Number(s?.incoming ?? 0),
          outgoing: Number(s?.outgoing ?? 0),
          failed: Number(s?.failed ?? 0),
        },
      }
    })
  })

  // Адрес пока прежний, хотя канал уже не обязательно телефонный номер:
  // менять его вместе с админкой будем одним заходом, когда добавим Телеграм.
  app.post<{ Body: { label?: string; kind?: string } }>(
    '/api/numbers',
    guarded,
    async (req, reply) => {
    const label = (req.body?.label ?? '').trim()
    if (label === '') return reply.code(400).send({ error: 'нужно поле label' })
    const kindRaw = req.body?.kind ?? 'whatsapp'
    if (!isKnownKind(kindRaw)) {
      return reply.code(400).send({ error: `неизвестный тип канала: ${kindRaw}` })
    }
    const kind = kindRaw
    return manager.addChannel(kind, label)
    },
  )

  app.get<{ Params: { id: string } }>('/api/numbers/:id/qr', guarded, async (req, reply) => {
    const qr = await manager.getQr(req.params.id)
    if (qr === null) {
      return reply.code(404).send({ error: 'QR пока не сгенерирован, обновите через пару секунд' })
    }
    return { qr }
  })

  app.post<{ Params: { id: string } }>('/api/numbers/:id/restart', guarded, async (req) => {
    await manager.restartChannel(req.params.id)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/api/numbers/:id', guarded, async (req) => {
    await manager.removeChannel(req.params.id)
    return { ok: true }
  })

  // --- сводка -----------------------------------------------------------

  app.get('/api/health', guarded, async () => {
    const numbers = await manager.listNumbers()
    const [counts] = await sql<
      { total: string; failed: string; queued: string; last24h: string }[]
    >`
      select count(*)::text                                                   as total,
             count(*) filter (where status = 'failed')::text                  as failed,
             count(*) filter (where status = 'queued')::text                  as queued,
             count(*) filter (where created_at > now() - interval '24 hours')::text as last24h
      from messages
    `
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      chatApiConnected: config.AMO_CHAT_CHANNEL_ID !== '' && config.AMO_CHAT_SCOPE_ID !== '',
      numbers: {
        total: numbers.length,
        online: numbers.filter((n) => n.status === 'online').length,
        problem: numbers.filter((n) => n.status === 'banned' || n.status === 'logged_out').length,
      },
      messages: {
        total: Number(counts?.total ?? 0),
        last24h: Number(counts?.last24h ?? 0),
        failed: Number(counts?.failed ?? 0),
        queued: Number(counts?.queued ?? 0),
      },
    }
  })

  // --- журнал сообщений -------------------------------------------------

  app.get<{
    Querystring: {
      number?: string
      status?: string
      direction?: string
      q?: string
      limit?: string
      offset?: string
    }
  }>('/api/messages', guarded, async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200)
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)
    const { number, status, direction, q } = req.query

    const rows = await sql<Record<string, unknown>[]>`
      select m.id::text, m.direction, m.type, m.status, m.error,
             m.occurred_at, m.sent_at, m.delivered_at, m.read_at,
             m.media_name, m.sender_name,
             n.label as number_label, n.phone as number_phone,
             c.phone as chat_phone, c.push_name as chat_name,
             case when m.type = 'text' then left(m.body, 200) else null end as preview
      from messages m
      join channels n on n.id = m.channel_id
      left join chats c on c.id = m.chat_id
      where (${number ?? null}::uuid is null or m.channel_id = ${number ?? null}::uuid)
        and (${status ?? null}::text is null or m.status = ${status ?? null})
        and (${direction ?? null}::text is null or m.direction = ${direction ?? null})
        and (${q ?? null}::text is null
             or c.phone ilike ${'%' + (q ?? '') + '%'}
             or c.push_name ilike ${'%' + (q ?? '') + '%'})
      order by m.occurred_at desc
      limit ${limit} offset ${offset}
    `
    return { items: rows, limit, offset }
  })

  /** Повторная отправка вручную — кнопка «повторить» в журнале. */
  app.post<{ Params: { id: string } }>('/api/messages/:id/retry', guarded, async (req, reply) => {
    const rows = await sql<
      {
        id: string
        channel_id: string
        external_chat_id: string
        type: string
        body: string | null
        media_path: string | null
        media_mime: string | null
        media_name: string | null
        amo_message_id: string | null
        status: string
      }[]
    >`
      select m.id::text, m.channel_id::text, c.external_chat_id, m.type, m.body,
             m.media_path, m.media_mime, m.media_name, m.amo_message_id, m.status
      from messages m join chats c on c.id = m.chat_id
      where m.id = ${req.params.id} and m.direction = 'out'
    `
    const msg = rows[0]
    if (msg === undefined) return reply.code(404).send({ error: 'исходящее сообщение не найдено' })
    if (msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'read') {
      return reply.code(409).send({ error: 'это сообщение уже доставлено' })
    }

    await sql`update messages set status = 'queued', error = null where id = ${msg.id}`
    await outboundQueue.add('retry', {
      dbMessageId: msg.id,
      channelId: msg.channel_id,
      externalChatId: msg.external_chat_id,
      type: msg.type as never,
      body: msg.body ?? '',
      ...(msg.media_path !== null ? { mediaPath: msg.media_path } : {}),
      ...(msg.media_mime !== null ? { mediaMime: msg.media_mime } : {}),
      ...(msg.media_name !== null ? { mediaName: msg.media_name } : {}),
      ...(msg.amo_message_id !== null ? { amoMessageId: msg.amo_message_id } : {}),
    })
    return { ok: true }
  })

  // --- настройки --------------------------------------------------------

  app.get('/api/settings', guarded, async () => getSettings())

  app.put('/api/settings', guarded, async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'неверные настройки',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    return saveSettings(parsed.data)
  })

  // --- вложения ---------------------------------------------------------

  // По этой ссылке файл забирает amoCRM, поэтому проверка не по ключу,
  // а по подписи в адресе.
  app.get<{ Params: { '*': string }; Querystring: { t?: string } }>(
    '/media/*',
    async (req, reply) => {
      const relPath = req.params['*']
      if (!verifyMediaToken(relPath, req.query.t ?? '')) {
        return reply.code(403).send({ error: 'неверная подпись ссылки' })
      }
      const abs = absoluteMediaPath(relPath)
      try {
        await stat(abs)
      } catch {
        return reply.code(404).send({ error: 'файл не найден' })
      }
      return reply.send(createReadStream(abs))
    },
  )

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'ошибка в Admin API')
    void reply.code(500).send({ error: 'внутренняя ошибка' })
  })

  return app
}
