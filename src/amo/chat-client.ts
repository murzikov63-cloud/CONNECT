import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import { signRequest } from './signature.js'

const logger = log('amo-chat')

export class AmoChatError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`Chat API amoCRM ответил ${status}: ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}

/** Низкоуровневый подписанный запрос к amojo. */
export async function amojoRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
): Promise<T> {
  if (config.AMO_CHAT_SECRET_KEY === '') {
    throw new Error('Не задан AMO_CHAT_SECRET_KEY — канал чатов ещё не подключён')
  }

  const body = payload === undefined ? '' : JSON.stringify(payload)
  const headers = signRequest(method, path, body, config.AMO_CHAT_SECRET_KEY)

  const response = await fetch(`${config.AMO_CHAT_BASE_URL}${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
  })

  const text = await response.text()
  if (!response.ok) {
    logger.error({ path, status: response.status }, 'ошибка Chat API')
    throw new AmoChatError(response.status, text)
  }
  return (text === '' ? {} : JSON.parse(text)) as T
}

export interface ConnectResult {
  account_id: string
  scope_id: string
  title: string
  hook_api_version: string
}

/**
 * Привязывает наш канал к аккаунту amoCRM. Возвращает scope_id —
 * им amoCRM подписывает вебхуки и по нему мы отличаем аккаунт.
 * Операция идемпотентная: повторный вызов вернёт тот же scope_id.
 */
export async function connectChannel(amojoId: string, title: string): Promise<ConnectResult> {
  return amojoRequest<ConnectResult>(
    'POST',
    `/v2/origin/custom/${config.AMO_CHAT_CHANNEL_ID}/connect`,
    { account_id: amojoId, title, hook_api_version: 'v2' },
  )
}

/** Отвязывает канал от аккаунта — на случай отката. */
export async function disconnectChannel(amojoId: string): Promise<void> {
  await amojoRequest(
    'POST',
    `/v2/origin/custom/${config.AMO_CHAT_CHANNEL_ID}/disconnect`,
    { account_id: amojoId },
  )
}
