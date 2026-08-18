import pino from 'pino'
import { config } from '../config/index.js'

/**
 * Контент сообщений в логи уровня info не попадает (раздел 5 ТЗ).
 * Тела сообщений логируем только на debug и только по явному вызову.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'body',
      'text',
      'caption',
      'message.body',
      '*.body',
      'creds',
      'token',
      'secret',
      'authorization',
      'req.headers.authorization',
    ],
    censor: '[скрыто]',
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
})

export const log = (scope: string) => logger.child({ scope })
