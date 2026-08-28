import 'dotenv/config'
import { z } from 'zod'

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  PUBLIC_DOMAIN: z.string().min(1),

  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGDATABASE: z.string().min(1),

  REDIS_URL: z.string().min(1),

  AMO_SUBDOMAIN: z.string().default(''),
  AMO_CLIENT_ID: z.string().default(''),
  AMO_CLIENT_SECRET: z.string().default(''),
  AMO_REDIRECT_URI: z.string().default(''),
  AMO_LONG_TOKEN: z.string().default(''),
  AMO_ACCOUNT_ID: z.coerce.number().int().default(0),
  AMO_AMOJO_ID: z.string().default(''),
  AMO_API_DOMAIN: z.string().default('api-b.amocrm.ru'),

  // Каналы чатов amoCRM — свой на каждый мессенджер. Так менеджер видит,
  // откуда пришла переписка, и может начать разговор в нужном мессенджере.
  // Ключи выдаёт техподдержка amoCRM по заявке.
  AMO_CHAT_BASE_URL: z.string().default('https://amojo.amocrm.ru'),

  AMO_WA_CHANNEL_ID: z.string().default(''),
  AMO_WA_SECRET_KEY: z.string().default(''),
  AMO_WA_SCOPE_ID: z.string().default(''),

  AMO_TG_CHANNEL_ID: z.string().default(''),
  AMO_TG_SECRET_KEY: z.string().default(''),
  AMO_TG_SCOPE_ID: z.string().default(''),

  AMO_MAX_CHANNEL_ID: z.string().default(''),
  AMO_MAX_SECRET_KEY: z.string().default(''),
  AMO_MAX_SCOPE_ID: z.string().default(''),

  TG_BOT_TOKEN: z.string().default(''),
  // Ключи приложения с my.telegram.org — общие для всех подключаемых номеров.
  TG_API_ID: z.coerce.number().int().default(0),
  TG_API_HASH: z.string().default(''),
  TG_ALERT_CHAT_ID: z.string().default(''),

  ADMIN_API_KEY: z.string().min(8),
  /**
   * Ключ для агента продаж (n8n). Отдельный от админского: у агента одно
   * право — отправить текст по сделке, и отзывается оно само по себе.
   * Пустой — агенту писать нельзя.
   */
  AGENT_API_TOKEN: z.string().default(''),
  /**
   * Куда сообщить, что клиент ответил, — чтобы агент продаж подготовил
   * следующий черновик. Пусто — не зовём никого.
   */
  AGENT_DRAFT_WEBHOOK_URL: z.string().default(''),
  // Пароль для входа в админку. Пустой — вход по паролю выключен.
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_CORS_ORIGIN: z.string().default(''),

  // Служба-переводчик к мессенджеру MAX: рабочая библиотека есть только
  // на Python, поэтому она живёт отдельным процессом в докер-сети.
  MAX_BRIDGE_URL: z.string().default('http://max-bridge:8090'),
  BRIDGE_SECRET: z.string().default(''),
  /**
   * Тайная часть адреса, по которому amoCRM сообщает нам о новых контактах.
   * Свои события amoCRM не подписывает, поэтому защита — в самом адресе.
   */
  AMO_EVENTS_SECRET: z.string().default(''),

  MEDIA_DIR: z.string().default('/app/media'),
  MEDIA_TTL_DAYS: z.coerce.number().int().default(180),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().default(3000),

  // Поведение отправки — раздел 5 ТЗ («human-like» лимиты).
  // Пауза перед ПЕРВЫМ сообщением незнакомому контакту: именно оно похоже
  // на рассылку, поэтому здесь длинная случайная задержка.
  NEW_CHAT_DELAY_MIN_MS: z.coerce.number().int().default(2000),
  NEW_CHAT_DELAY_MAX_MS: z.coerce.number().int().default(8000),
  // Ответ в уже идущем диалоге: задержка короткая, иначе не уложимся
  // в «ответ менеджера доходит за 5 секунд» из раздела 8 ТЗ.
  REPLY_DELAY_MIN_MS: z.coerce.number().int().default(300),
  REPLY_DELAY_MAX_MS: z.coerce.number().int().default(1500),
  NEW_CHATS_PER_NUMBER_PER_DAY: z.coerce.number().int().default(30),
  IGNORE_GROUPS: bool.default('true'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')
  throw new Error(`Некорректная конфигурация (.env):\n  ${issues}`)
}

export const config = parsed.data
export type Config = typeof config

/** Есть ли хотя бы один настроенный канал чатов. */
export const chatApiReady = (): boolean =>
  config.AMO_TG_SCOPE_ID !== '' || config.AMO_WA_SCOPE_ID !== '' || config.AMO_MAX_SCOPE_ID !== ''
