import { alert } from '../alerts/index.js'
import { chatApiReady } from '../config/index.js'
import { sql } from '../db/index.js'
import { log } from '../logger/index.js'

const logger = log('daily')

/**
 * Ежедневная сводка о работе сервиса.
 *
 * Тревоги ловят поломки, которые кричат: сообщение не ушло, номер отвалился.
 * Хуже те, что молчат. 22 сентября WhatsApp перестал доставлять сообщения
 * по прежним адресам: ошибок не было ни одной, в карточках стояло
 * «отправлено», и два дня никто ничего не замечал. Поэтому смотрим ещё
 * и на признаки: сколько сообщений зависло в пути, идут ли входящие,
 * не копится ли очередь.
 */

/** Что происходит в одном мессенджере за сутки. */
export interface ПоМессенджеру {
  мессенджер: string
  вСети: boolean
  входящих: number
  исходящих: number
  неУшло: number
  зависших: number
}

export interface Сводка {
  каналыВсего: number
  каналыВСети: number
  отвалились: string[]
  входящих: number
  исходящих: number
  неУшло: number
  зависших: number
  вОчереди: number
  чатыAmo: boolean
  мессенджеры: ПоМессенджеру[]
}

/** Сколько часов ждём подтверждения доставки, прежде чем считать зависшим. */
export const ЖДЁМ_ЧАСОВ = 4

export async function собратьСводку(): Promise<Сводка> {
  const каналы = await sql<{ label: string; status: string; kind: string }[]>`
    select label, status, kind from channels where deleted_at is null and status <> 'new'
  `
  const сообщения = await sql<
    { входящих: string; исходящих: string; не_ушло: string; в_очереди: string }[]
  >`
    select
      count(*) filter (where direction = 'in'  and created_at > now() - interval '24 hours')::text as входящих,
      count(*) filter (where direction = 'out' and created_at > now() - interval '24 hours')::text as исходящих,
      count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::text as не_ушло,
      count(*) filter (where status = 'queued')::text as в_очереди
    from messages
  `
  // Зависшие: мессенджер принял, но подтверждения так и нет. Смотрим только
  // за сутки, чтобы в сводку не попадали следы прошлых поломок.
  const зависшие = await sql<{ n: string }[]>`
    select count(*)::text as n from messages
    where direction = 'out' and status = 'sent'
      and delivered_at is null and read_at is null
      and created_at > now() - interval '24 hours'
      and created_at < now() - make_interval(hours => ${ЖДЁМ_ЧАСОВ})
  `

  // Разбивка по мессенджерам: в общей цифре поломка одного канала тонет.
  // В сентябре перестал доставлять только WhatsApp, а Телеграм и MAX
  // работали — вместе это выглядело бы как обычный день.
  const поМессенджерам = await sql<
    {
      kind: string
      входящих: string
      исходящих: string
      не_ушло: string
      зависших: string
    }[]
  >`
    select ch.kind,
      count(*) filter (where m.direction = 'in')::text  as входящих,
      count(*) filter (where m.direction = 'out')::text as исходящих,
      count(*) filter (where m.status = 'failed')::text as не_ушло,
      count(*) filter (
        where m.direction = 'out' and m.status = 'sent'
          and m.delivered_at is null and m.read_at is null
          and m.created_at < now() - make_interval(hours => ${ЖДЁМ_ЧАСОВ})
      )::text as зависших
    from channels ch
    left join messages m
      on m.channel_id = ch.id and m.created_at > now() - interval '24 hours'
    where ch.deleted_at is null and ch.status <> 'new'
    group by ch.kind
    order by ch.kind
  `

  const названия: Record<string, string> = {
    whatsapp: 'WhatsApp',
    telegram: 'Телеграм',
    max: 'MAX',
  }
  const вСети = new Set(каналы.filter((c) => c.status === 'online').map((c) => c.kind))

  const строка = сообщения[0]
  return {
    мессенджеры: поМессенджерам.map((r) => ({
      мессенджер: названия[r.kind] ?? r.kind,
      вСети: вСети.has(r.kind),
      входящих: Number(r.входящих),
      исходящих: Number(r.исходящих),
      неУшло: Number(r.не_ушло),
      зависших: Number(r.зависших),
    })),
    каналыВсего: каналы.length,
    каналыВСети: каналы.filter((c) => c.status === 'online').length,
    отвалились: каналы.filter((c) => c.status !== 'online').map((c) => c.label),
    входящих: Number(строка?.входящих ?? 0),
    исходящих: Number(строка?.исходящих ?? 0),
    неУшло: Number(строка?.не_ушло ?? 0),
    зависших: Number(зависшие[0]?.n ?? 0),
    вОчереди: Number(строка?.в_очереди ?? 0),
    чатыAmo: chatApiReady(),
  }
}

/** Что из сводки требует внимания человека. */
export function поводыДляТревоги(с: Сводка): string[] {
  const поводы: string[] = []
  if (с.отвалились.length > 0) поводы.push(`не в сети: ${с.отвалились.join(', ')}`)
  if (с.зависших > 0) {
    поводы.push(`${с.зависших} сообщений висят в пути дольше ${ЖДЁМ_ЧАСОВ} часов`)
  }
  if (с.неУшло > 0) поводы.push(`${с.неУшло} не ушло клиентам`)
  if (с.вОчереди > 20) поводы.push(`очередь не разбирается: ${с.вОчереди} ждут отправки`)
  if (!с.чатыAmo) поводы.push('нет связи с чатами amoCRM')
  return поводы
}

export async function отправитьСводку(): Promise<void> {
  const с = await собратьСводку()
  const поводы = поводыДляТревоги(с)

  const детали: Record<string, unknown> = {
    Каналы: `${с.каналыВСети} из ${с.каналыВсего} в сети`,
    'За сутки': `${с.входящих} входящих, ${с.исходящих} исходящих`,
  }
  // Каждый мессенджер отдельной строкой: так видно, который из них молчит.
  for (const м of с.мессенджеры) {
    const хвост = [
      м.вСети ? null : 'не в сети',
      м.зависших > 0 ? `${м.зависших} висят` : null,
      м.неУшло > 0 ? `${м.неУшло} не ушло` : null,
    ].filter((x) => x !== null)
    детали[м.мессенджер] =
      `${м.входящих} вх, ${м.исходящих} исх` + (хвост.length > 0 ? ` — ${хвост.join(', ')}` : '')
  }
  if (поводы.length > 0) детали['Что проверить'] = поводы.join('; ')

  await alert(
    поводы.length > 0 ? 'warn' : 'info',
    поводы.length > 0 ? 'Сводка за сутки: есть на что посмотреть' : 'Сводка за сутки: всё в порядке',
    детали,
    // Сводка выходит раз в день — глушить её окном охлаждения не нужно.
    0,
  )
  logger.info({ ...с }, 'сводка отправлена')
}

/**
 * Присылает сводку каждое утро. Час выбран так, чтобы она лежала в чате
 * к началу рабочего дня по Москве, а не будила ночью.
 */
export function запуститьЕжедневнуюСводку(часUTC = 6): () => void {
  let таймер: NodeJS.Timeout | null = null

  const черезСколько = (): number => {
    const сейчас = new Date()
    const цель = new Date(сейчас)
    цель.setUTCHours(часUTC, 0, 0, 0)
    if (цель <= сейчас) цель.setUTCDate(цель.getUTCDate() + 1)
    return цель.getTime() - сейчас.getTime()
  }

  const поставить = (): void => {
    таймер = setTimeout(() => {
      void отправитьСводку().catch((err: unknown) => logger.error({ err }, 'сводка не собралась'))
      поставить()
    }, черезСколько())
    таймер.unref()
  }
  поставить()

  return () => {
    if (таймер !== null) clearTimeout(таймер)
  }
}
