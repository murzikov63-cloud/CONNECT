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

  // Приходят от техподдержки amoCRM после регистрации канала.
  AMO_CHAT_CHANNEL_ID: z.string().default(''),
  AMO_CHAT_SECRET_KEY: z.string().default(''),
  AMO_CHAT_CODE: z.string().default(''),
  AMO_CHAT_SCOPE_ID: z.string().default(''),
  AMO_CHAT_BASE_URL: z.string().default('https://amojo.amocrm.ru'),

  TG_BOT_TOKEN: z.string().default(''),
  TG_ALERT_CHAT_ID: z.string().default(''),

  ADMIN_API_KEY: z.string().min(8),
  // Пароль для входа в админку. Пустой — вход по паролю выключен.
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_CORS_ORIGIN: z.string().default(''),

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

/** Chat API amoCRM ещё не подключён — до ответа техподдержки это нормально. */
export const chatApiReady = (): boolean =>
  config.AMO_CHAT_CHANNEL_ID !== '' && config.AMO_CHAT_SECRET_KEY !== ''
