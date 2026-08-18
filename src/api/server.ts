import cors from '@fastify/cors'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import { absoluteMediaPath, verifyMediaToken } from '../wa/media.js'
import type { SessionManager } from '../wa/manager.js'

const logger = log('api')

/**
 * Минимальный Admin API — ровно столько, чтобы подключить номер по QR
 * и увидеть состояние. Полный контракт из раздела 6 ТЗ — этап 4.
 */
export async function buildServer(manager: SessionManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 })

  await app.register(cors, {
    origin: config.ADMIN_CORS_ORIGIN === '' ? false : config.ADMIN_CORS_ORIGIN.split(','),
  })

  const requireKey = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = req.headers['x-api-key']
    if (key !== config.ADMIN_API_KEY) {
      await reply.code(401).send({ error: 'нужен заголовок X-Api-Key' })
    }
  }

  app.get('/api/health', async () => {
    const numbers = await manager.listNumbers()
    return {
      ok: true,
      chatApiConnected: config.AMO_CHAT_CHANNEL_ID !== '',
      numbers: numbers.map((n) => ({
        id: n.id,
        label: n.label,
        phone: n.phone,
        status: n.status,
        lastConnectedAt: n.last_connected_at,
      })),
    }
  })

  app.get('/api/numbers', { preHandler: requireKey }, async () => manager.listNumbers())

  app.post<{ Body: { label?: string } }>(
    '/api/numbers',
    { preHandler: requireKey },
    async (req, reply) => {
      const label = req.body?.label ?? ''
      if (label.trim() === '') return reply.code(400).send({ error: 'нужно поле label' })
      return manager.addNumber(label.trim())
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/numbers/:id/qr',
    { preHandler: requireKey },
    async (req, reply) => {
      const qr = await manager.getQr(req.params.id)
      if (qr === null) return reply.code(404).send({ error: 'QR пока не сгенерирован' })
      return { qr }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/numbers/:id/restart',
    { preHandler: requireKey },
    async (req) => {
      await manager.restartNumber(req.params.id)
      return { ok: true }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/numbers/:id',
    { preHandler: requireKey },
    async (req) => {
      await manager.removeNumber(req.params.id)
      return { ok: true }
    },
  )

  // Отдача вложений по подписанной ссылке — по ней файл забирает amoCRM,
  // поэтому здесь не X-Api-Key, а токен в query.
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
