/**
 * Отправка сообщения от лица агента продаж.
 *
 * Отличие от всего остального исходящего: обычные исходящие приходят
 * вебхуком из amoCRM, то есть amoCRM про них уже знает. Здесь инициатор —
 * наш бот, и amoCRM про сообщение не знает ничего. Поэтому после успешной
 * отправки его нужно ещё и показать в карточке — тем же путём, каким
 * туда попадают ответы менеджера с телефона (см. amo/inbound.ts).
 */
import { z } from 'zod'

/** Тело запроса к POST /api/messages. */
export const agentSendSchema = z
  .object({
    /** Сделка amoCRM — основной способ адресации: агент работает по сделке. */
    leadId: z.coerce.number().int().positive().optional(),
    /** Прямое указание переписки, если она уже известна вызывающему. */
    chatId: z.string().min(1).optional(),
    /** В каком мессенджере писать, если у сделки их несколько. */
    kind: z.enum(['whatsapp', 'telegram', 'max']).optional(),
    text: z.string().min(1).max(4096),
    /**
     * Ключ повтора: n8n перезапускает узел при любой сетевой ошибке,
     * и без него одобренный черновик ушёл бы клиенту дважды.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.leadId !== undefined || v.chatId !== undefined, {
    message: 'нужен leadId или chatId',
  })

export type AgentSendBody = z.infer<typeof agentSendSchema>

/** Переписка-кандидат: у одной сделки их может быть несколько. */
export interface ChatCandidate {
  chat_id: string
  channel_id: string
  external_chat_id: string
  phone: string | null
  channel_kind: string
  last_message_at: Date | null
}

/**
 * Куда писать, если у сделки несколько переписок.
 *
 * Явно названный мессенджер главнее всего. Дальше — та переписка, где
 * разговор шёл последним: клиент отвечает там, где писал сам, и переносить
 * его в другой мессенджер без причины не нужно. Переписка вообще без
 * сообщений — последний вариант: обычно это заведённая про запас беседа.
 */
export function pickChat(rows: ChatCandidate[], kind?: string): ChatCandidate | null {
  const pool = kind === undefined ? rows : rows.filter((r) => r.channel_kind === kind)
  if (pool.length === 0) return null

  const byRecency = [...pool].sort((a, b) => {
    const at = a.last_message_at?.getTime() ?? 0
    const bt = b.last_message_at?.getTime() ?? 0
    return bt - at
  })
  return byRecency[0] ?? null
}
