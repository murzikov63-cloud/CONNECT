import { alert } from './alerts/index.js'
import { buildServer } from './api/server.js'
import { config } from './config/index.js'
import { closeDb, migrate } from './db/index.js'
import { log } from './logger/index.js'
import { closeQueues, inboundQueue } from './queue/index.js'
import { createOutboundWorker } from './queue/outbound.js'
import { cleanupOldMedia } from './wa/media.js'
import { ChannelManager } from './channels/manager.js'

const logger = log('boot')

async function main(): Promise<void> {
  await migrate()

  const manager = new ChannelManager()
  const outboundWorker = createOutboundWorker(manager)

  // Сохранённое входящее уходит в очередь; коннектор amoCRM (этап 3)
  // разбирает её и создаёт чат/сделку. Пока канал чатов не выдан —
  // сообщения копятся в очереди и не теряются.
  manager.on('inbound', (msg: { dbId: string; channelId: string; chat: { id: string } }) => {
    void inboundQueue
      .add(
        'to-amo',
        { dbMessageId: msg.dbId, channelId: msg.channelId, chatId: msg.chat.id },
        { jobId: `in:${msg.dbId}` },
      )
      .catch((err: unknown) => logger.error({ err }, 'не удалось поставить входящее в очередь'))
  })

  await manager.bootstrap()

  const app = await buildServer(manager)
  await app.listen({ host: '0.0.0.0', port: config.PORT })
  logger.info({ port: config.PORT }, 'сервис поднят')

  const mediaCleanup = setInterval(
    () => {
      void cleanupOldMedia().catch((err: unknown) =>
        logger.error({ err }, 'уборка медиа не удалась'),
      )
    },
    24 * 60 * 60 * 1000,
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'останавливаюсь')
    clearInterval(mediaCleanup)
    await app.close()
    await outboundWorker.close()
    await manager.shutdown()
    await closeQueues()
    await closeDb()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'сервис не смог стартовать')
  void alert('error', 'Сервис Messenger не смог стартовать', {
    Ошибка: err instanceof Error ? err.message : String(err),
  }).finally(() => process.exit(1))
})
