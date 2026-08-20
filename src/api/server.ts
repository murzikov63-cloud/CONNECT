import cors from '@fastify/cors'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { COOLDOWN_DAILY_MS, alert } from '../alerts/index.js'
import { channelForScope } from '../amo/channels.js'
import type { MaxDriver, MaxIncoming } from '../max/driver.js'
import { chatApiReady, config } from '../config/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'
import { outboundQueue } from '../queue/index.js'
import { getSettings, saveSettings } from '../settings.js'
import type { ChannelManager } from '../channels/manager.js'
import { absoluteMediaPath, verifyMediaToken } from '../wa/media.js'
import { isKnownKind } from '../channels/registry.js'
import { CAPABILITIES, CHANNEL_TITLES } from '../channels/types.js'
import {
  describeSignatureMismatch,
  parseOutgoing,
  resolveChat,
  verifyWebhookSignature,
} from '../amo/webhook.js'
import {
  checkGuestPassword,
  guestAccessExpiry,
  issueGuestPassword,
  revokeGuestPassword,
} from './guest.js'
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

  // Подпись вебхука amoCRM считается от СЫРОГО тела, поэтому сохраняем его
  // до разбора: пересобранный JSON даст другую строку и другую подпись.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const holder = req as unknown as { rawBody: string }
      holder.rawBody = body as string
      try {
        done(null, body === '' ? {} : JSON.parse(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

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
    const scope = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null
    if (scope === null) {
      await reply.code(401).send({ error: 'нужен вход' })
      return
    }
    if (scope === 'admin') return

    // Вошедший по временному паролю работает как обычно, но пароль могли
    // отозвать, пока страница у него открыта. Поэтому проверяем на каждом
    // запросе: отзыв должен срабатывать сразу, а не когда истечёт токен.
    if ((await guestAccessExpiry()) === null) {
      await reply.code(401).send({ error: 'временный пароль больше не действует' })
      return
    }

    // Единственное, чего по временному паролю нельзя: выдать временный
    // пароль. Иначе временный доступ продлевал бы сам себя без конца.
    const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '')
    if (path === '/api/access/guest' && req.method !== 'GET') {
      await reply.code(403).send({ error: 'по временному паролю этого нельзя' })
      return
    }
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
      available: true,
      ...caps,
    })),
  )

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const ip = req.headers['cf-connecting-ip']?.toString() ?? req.ip
    if (loginBlocked(ip)) {
      return reply.code(429).send({ error: 'слишком много попыток, подождите 15 минут' })
    }
    const password = req.body?.password ?? ''
    if (checkPassword(password)) {
      registerSuccess(ip)
      return issueToken()
    }

    // Временный пароль: срок токена — до конца выданного окна, не дольше.
    const guestUntil = await checkGuestPassword(password)
    if (guestUntil !== null) {
      registerSuccess(ip)
      logger.info({ ip }, 'вход по временному паролю')
      return issueToken(Date.now(), 'guest', guestUntil)
    }

    registerFailure(ip)
    logger.warn({ ip }, 'неудачная попытка входа')
    return reply.code(401).send({ error: 'неверный пароль' })
  })

  // --- временный доступ -------------------------------------------------

  /** Срок действующего временного пароля. Сам пароль не хранится. */
  app.get('/api/access/guest', guarded, async () => ({
    expiresAt: await guestAccessExpiry(),
  }))

  /**
   * Заводит временный пароль: обычный вход в админку, но со сроком
   * и с отзывом в одно нажатие. Показывается один раз — у нас остаётся
   * только его отпечаток, восстановить нельзя, можно выдать новый.
   */
  app.post<{ Body: { hours?: number } }>('/api/access/guest', guarded, async (req, reply) => {
    const hours = Number(req.body?.hours ?? 3)
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return reply.code(400).send({ error: 'срок — от нескольких минут до суток' })
    }
    const issued = await issueGuestPassword(hours)
    logger.info({ expiresAt: issued.expiresAt }, 'выдан временный пароль')
    return issued
  })

  app.delete('/api/access/guest', guarded, async () => {
    await revokeGuestPassword()
    logger.info({}, 'временный пароль отозван')
    return { ok: true }
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
  app.post<{ Body: { label?: string; kind?: string; password?: string } }>(
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
    const password = req.body?.password
    return manager.addChannel(kind, label, password === undefined ? undefined : { password })
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
      chatApiConnected: chatApiReady(),
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

  // --- входящие из MAX --------------------------------------------------

  /**
   * Сюда служба-переводчик MAX приносит входящие сообщения.
   * Наружу этот адрес не выведен: Caddy его не проксирует, служба
   * обращается к нам напрямую внутри докер-сети.
   */
  app.post<{ Body: MaxIncoming }>('/internal/max/incoming', async (req, reply) => {
    if (config.BRIDGE_SECRET === '' || req.headers['x-bridge-secret'] !== config.BRIDGE_SECRET) {
      return reply.code(401).send({ error: 'неверный ключ службы' })
    }

    const driver = manager.getDriver(req.body.channelId)
    if (driver === undefined || driver.kind !== 'max') {
      logger.warn({ channelId: req.body.channelId }, 'входящее MAX для неизвестного канала')
      return reply.code(404).send({ error: 'канал не найден' })
    }

    const maxDriver = driver as unknown as MaxDriver
    maxDriver.ingest(req.body)
    return { ok: true }
  })

  // --- ответы менеджеров из amoCRM --------------------------------------

  /**
   * Сюда amoCRM стучится, когда менеджер пишет в чате карточки.
   * Отвечаем быстро: тяжёлое делает очередь.
   */
  app.post<{ Params: { scopeId: string } }>('/amojo/:scopeId', async (req, reply) => {
    // По адресу понимаем, какого мессенджера пришёл ответ: у каждого
    // свой канал и свой ключ для проверки подписи.
    const amoChannel = channelForScope(req.params.scopeId)
    if (amoChannel === null) {
      return reply.code(404).send({ error: 'неизвестный канал' })
    }

    const raw = (req as unknown as { rawBody?: string }).rawBody ?? ''
    const signature = String(req.headers['x-signature'] ?? '')
    if (!verifyWebhookSignature(amoChannel.secretKey, raw, signature)) {
      const report = describeSignatureMismatch(
        amoChannel,
        raw,
        signature,
        req.headers as Record<string, unknown>,
      )
      logger.warn(report, 'подпись вебхука не сошлась')

      // Пока способ подписи не выяснен, запрос всё же обрабатываем: адрес
      // содержит scope_id, который знают только amoCRM и мы, так что защита
      // остаётся, хоть и слабее. Владельцу об этом сообщаем, чтобы это
      // не осталось незамеченным навсегда.
      // Раз в сутки, а не на каждое сообщение: состояние известное,
      // ждём ответа техподдержки amoCRM, а не новостей.
      void alert(
        'warn',
        'amoCRM подписывает вебхуки не так, как ожидалось',
        { Последствие: 'ответы менеджеров принимаются с проверкой только по адресу' },
        COOLDOWN_DAILY_MS,
      )
      // Сырое тело кладём рядом с медиа — по нему подберём верный способ.
      void writeFile(
        join(config.MEDIA_DIR, `_webhook-${Date.now()}.json`),
        JSON.stringify({ signature, headers: req.headers, body: raw }, null, 2),
      ).catch(() => {
        /* не критично */
      })
    }

    const parsed = parseOutgoing(req.body)
    if (parsed === null) {
      // Форма вебхука могла измениться — записываем состав полей без содержимого.
      logger.warn(
        { keys: Object.keys((req.body ?? {}) as Record<string, unknown>) },
        'не смог разобрать вебхук amoCRM',
      )
      return reply.code(200).send({ ok: true })
    }

    let chat = await resolveChat(parsed, amoChannel.kind)

    // Переписки нет вовсе: менеджер пишет первым тому, кто нам ещё
    // не писал. С заявки известен только номер — по нему и находим
    // человека в мессенджере и заводим переписку.
    if (chat === null && parsed.receiverPhone !== '') {
      const opened = await manager.openChatByPhone(
        amoChannel.kind,
        parsed.receiverPhone,
        parsed.receiverName,
      )
      if (opened !== null) {
        // Отвечать клиент будет в ту же беседу, что видит менеджер.
        if (parsed.amoChatId !== '') {
          await sql`
            update chats set amo_started_chat_id = ${parsed.amoChatId}, updated_at = now()
            where id = ${opened.chat_id}
          `
        }
        chat = { ...opened, amo_chat_id: null }
      }
    }

    if (chat === null) {
      // Вот теперь это потеря: менеджер написал, а мы не смогли доставить.
      logger.warn(
        {
          мессенджер: amoChannel.kind,
          телефонПолучателя: parsed.receiverPhone === '' ? 'нет' : 'есть',
        },
        'сообщение менеджера некуда доставить',
      )
      return reply.code(200).send({ ok: true })
    }

    const inserted = await sql<{ id: string }[]>`
      insert into messages (
        channel_id, chat_id, amo_message_id, direction, type, body,
        media_path, media_name, media_size, status, occurred_at
      ) values (
        ${chat.channel_id}, ${chat.chat_id}, ${parsed.amoMessageId}, 'out',
        ${parsed.type}, ${parsed.text},
        ${parsed.media ?? null}, ${parsed.fileName ?? null}, ${parsed.fileSize ?? null},
        'queued', now()
      )
      on conflict do nothing
      returning id::text as id
    `
    const row = inserted[0]
    if (row === undefined) {
      // Повтор того же вебхука — amoCRM иногда шлёт дважды.
      return reply.code(200).send({ ok: true })
    }

    await outboundQueue.add('from-amo', {
      dbMessageId: row.id,
      channelId: chat.channel_id,
      externalChatId: chat.external_chat_id,
      ...(parsed.receiverPhone !== '' ? { phone: parsed.receiverPhone } : {}),
      type: parsed.type,
      body: parsed.text,
      ...(parsed.media !== undefined ? { mediaPath: parsed.media } : {}),
      ...(parsed.fileName !== undefined ? { mediaName: parsed.fileName } : {}),
      ...(parsed.amoMessageId !== '' ? { amoMessageId: parsed.amoMessageId } : {}),
    })

    return reply.code(200).send({ ok: true })
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
