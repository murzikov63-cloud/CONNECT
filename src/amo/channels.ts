import { config } from '../config/index.js'
import type { ChannelKind } from '../channels/types.js'

/**
 * Канал чатов amoCRM. Каждому мессенджеру — свой: только так менеджер
 * видит в карточке, откуда пришла переписка, и может начать разговор
 * в нужном мессенджере. Один общий канал этого не позволяет.
 */
export interface AmoChannel {
  kind: ChannelKind
  channelId: string
  secretKey: string
  /** Выдаётся при подключении канала к аккаунту. */
  scopeId: string
}

function build(kind: ChannelKind, id: string, secret: string, scope: string): AmoChannel {
  return { kind, channelId: id, secretKey: secret, scopeId: scope }
}

export function amoChannels(): AmoChannel[] {
  return [
    build('whatsapp', config.AMO_WA_CHANNEL_ID, config.AMO_WA_SECRET_KEY, config.AMO_WA_SCOPE_ID),
    build('telegram', config.AMO_TG_CHANNEL_ID, config.AMO_TG_SECRET_KEY, config.AMO_TG_SCOPE_ID),
    build('max', config.AMO_MAX_CHANNEL_ID, config.AMO_MAX_SECRET_KEY, config.AMO_MAX_SCOPE_ID),
  ]
}

export function channelForKind(kind: ChannelKind): AmoChannel {
  const found = amoChannels().find((c) => c.kind === kind)
  if (found === undefined || found.channelId === '') {
    throw new Error(`Для мессенджера «${kind}» не задан канал amoCRM`)
  }
  return found
}

/** По адресу вебхука понимаем, какого мессенджера пришёл ответ менеджера. */
export function channelForScope(scopeId: string): AmoChannel | null {
  if (scopeId === '') return null
  return amoChannels().find((c) => c.scopeId !== '' && c.scopeId === scopeId) ?? null
}
