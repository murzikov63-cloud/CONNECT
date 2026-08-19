import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import type { AmoChannel } from './channels.js'
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

/** Низкоуровневый подписанный запрос к amojo. Подпись — ключом своего канала. */
export async function amojoRequest<T>(
  channel: AmoChannel,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
): Promise<T> {
  if (channel.secretKey === '') {
    throw new Error(`Для канала «${channel.kind}» не задан ключ amoCRM`)
  }

  const body = payload === undefined ? '' : JSON.stringify(payload)
  // Подпись считается по пути БЕЗ параметров запроса: с ними amoCRM
  // отвечает 403. В документации это не сказано, выяснено опытом.
  const signedPath = path.split('?')[0] ?? path
  const headers = signRequest(method, signedPath, body, channel.secretKey)

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
export async function connectChannel(
  channel: AmoChannel,
  amojoId: string,
  title: string,
): Promise<ConnectResult> {
  return amojoRequest<ConnectResult>(
    channel,
    'POST',
    `/v2/origin/custom/${channel.channelId}/connect`,
    { account_id: amojoId, title, hook_api_version: 'v2' },
  )
}

/** Типы сообщений, которые понимает amoCRM. */
export type AmoMessageType =
  | 'text'
  | 'contact'
  | 'file'
  | 'video'
  | 'picture'
  | 'voice'
  | 'audio'
  | 'sticker'
  | 'location'

/** Наши типы -> типы amoCRM. Незнакомое отдаём текстом, чтобы не терять. */
export function toAmoType(type: string): AmoMessageType {
  switch (type) {
    case 'image':
      return 'picture'
    case 'document':
      return 'file'
    case 'video':
      return 'video'
    case 'voice':
      return 'voice'
    case 'audio':
      return 'audio'
    case 'sticker':
      return 'sticker'
    case 'location':
      return 'location'
    case 'contact':
      return 'contact'
    default:
      return 'text'
  }
}

export interface AmoUser {
  id: string
  name: string
  avatar?: string
  profile?: { phone?: string; email?: string }
  profile_link?: string
}

export interface CreateChatResult {
  id: string
  user: { id: string; client_id: string }
}

/**
 * Создаёт чат на стороне amoCRM. Идемпотентно: повторный вызов с тем же
 * conversation_id возвращает тот же чат.
 */
export async function createChat(
  channel: AmoChannel,
  conversationId: string,
  user: AmoUser,
): Promise<CreateChatResult> {
  return amojoRequest<CreateChatResult>(
    channel,
    'POST',
    `/v2/origin/custom/${channel.scopeId}/chats`,
    { conversation_id: conversationId, user },
  )
}

export interface SendMessageInput {
  conversationId: string
  msgid: string
  /** Кто отправил: клиент — для входящих, наш аккаунт — для исходящих. */
  sender: AmoUser
  /**
   * Кому. Заполняется только для исходящих: по паре «отправитель —
   * получатель» amoCRM понимает, что сообщение от бизнеса, а не от клиента,
   * и рисует его справа, а не слева.
   */
  receiver?: AmoUser
  type: AmoMessageType
  text: string
  media?: string
  fileName?: string
  fileSize?: number
  occurredAt: Date
  /** true — не поднимать уведомление у менеджера (например, эхо своей отправки). */
  silent?: boolean
}

export interface SendMessageResult {
  new_message: { msgid: string; ref_id: string; conversation_id: string }
}

/** Кладёт входящее сообщение в чат amoCRM. */
export async function sendMessageToAmo(
  channel: AmoChannel,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const message: Record<string, unknown> = { type: input.type, text: input.text }
  if (input.media !== undefined) message['media'] = input.media
  if (input.fileName !== undefined) message['file_name'] = input.fileName
  if (input.fileSize !== undefined) message['file_size'] = input.fileSize

  return amojoRequest<SendMessageResult>(channel, 'POST', `/v2/origin/custom/${channel.scopeId}`, {
    event_type: 'new_message',
    payload: {
      timestamp: Math.floor(input.occurredAt.getTime() / 1000),
      msec_timestamp: input.occurredAt.getTime(),
      msgid: input.msgid,
      conversation_id: input.conversationId,
      sender: input.sender,
      ...(input.receiver !== undefined ? { receiver: input.receiver } : {}),
      message,
      silent: input.silent ?? false,
    },
  })
}

/** Коды состояния доставки, которые понимает amoCRM. */
export const DELIVERY = { delivered: 1, read: 2, failed: -1 } as const

/** Отмечает в amoCRM, что сообщение менеджера дошло, прочитано или не ушло. */
export async function setDeliveryStatus(
  channel: AmoChannel,
  amoMessageId: string,
  statusCode: number,
  error?: string,
): Promise<void> {
  const body: Record<string, unknown> = { msgid: amoMessageId, delivery_status: statusCode }
  if (error !== undefined) {
    // 905 — «прочая ошибка», единственный код, к которому положен текст.
    body['error_code'] = 905
    body['error'] = error.slice(0, 300)
  }
  await amojoRequest(
    channel,
    'POST',
    `/v2/origin/custom/${channel.scopeId}/${amoMessageId}/delivery_status`,
    body,
  )
}

/** Отвязывает канал от аккаунта — на случай отката. */
export async function disconnectChannel(channel: AmoChannel, amojoId: string): Promise<void> {
  await amojoRequest(channel, 'POST', `/v2/origin/custom/${channel.channelId}/disconnect`, {
    account_id: amojoId,
  })
}
