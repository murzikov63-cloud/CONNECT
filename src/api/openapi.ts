import { config } from '../config/index.js'

/**
 * Спецификация Admin API. Отдаётся по /api/openapi.json — фронт в Lovable
 * читает её и генерирует клиент, чтобы не расходиться с бэкендом руками.
 */
export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Messenger Admin API',
    version: '1.0.0',
    description:
      'Управление мостом WhatsApp ⇄ amoCRM: подключение номеров, журнал сообщений, настройки.',
  },
  servers: [{ url: `https://${config.PUBLIC_DOMAIN}` }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Токен из POST /api/auth/login. Живёт 12 часов.',
      },
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        description: 'Постоянный ключ для скриптов. Во фронт не зашивать.',
      },
    },
    schemas: {
      Number: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['whatsapp', 'telegram', 'max'] },
          kindTitle: { type: 'string', example: 'WhatsApp' },
          label: { type: 'string', example: 'Отдел продаж 1' },
          phone: { type: 'string', nullable: true, example: '79991234567' },
          status: {
            type: 'string',
            enum: ['new', 'connecting', 'qr', 'online', 'offline', 'banned', 'logged_out'],
          },
          lastConnectedAt: { type: 'string', format: 'date-time', nullable: true },
          lastDisconnectReason: { type: 'string', nullable: true },
          uptimeSec: { type: 'integer' },
          last24h: {
            type: 'object',
            properties: {
              incoming: { type: 'integer' },
              outgoing: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          direction: { type: 'string', enum: ['in', 'out'] },
          type: {
            type: 'string',
            enum: [
              'text', 'image', 'video', 'audio', 'voice',
              'document', 'sticker', 'location', 'contact', 'unsupported',
            ],
          },
          status: {
            type: 'string',
            enum: ['received', 'queued', 'sent', 'delivered', 'read', 'failed'],
          },
          error: { type: 'string', nullable: true },
          preview: { type: 'string', nullable: true, description: 'Первые 200 символов текста' },
          occurred_at: { type: 'string', format: 'date-time' },
          number_label: { type: 'string' },
          chat_phone: { type: 'string', nullable: true },
          chat_name: { type: 'string', nullable: true },
          media_name: { type: 'string', nullable: true },
        },
      },
      Settings: {
        type: 'object',
        properties: {
          personalNumbers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Личные номера: переписку с ними в amoCRM не отдаём',
          },
          ignoreGroups: { type: 'boolean' },
          newChatsPerNumberPerDay: { type: 'integer', minimum: 0, maximum: 1000 },
          newChatDelayMinMs: { type: 'integer' },
          newChatDelayMaxMs: { type: 'integer' },
          replyDelayMinMs: { type: 'integer' },
          replyDelayMaxMs: { type: 'integer' },
          amoPipelineId: { type: 'integer', nullable: true },
          amoStatusId: { type: 'integer', nullable: true },
        },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Живость сервиса (без авторизации, для мониторинга)',
        security: [],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/auth/login': {
      post: {
        summary: 'Войти по паролю и получить токен',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                properties: { password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Токен на 12 часов',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string' },
                    expiresAt: { type: 'integer', description: 'Unix-время в миллисекундах' },
                  },
                },
              },
            },
          },
          '401': { description: 'Неверный пароль' },
          '429': { description: 'Слишком много попыток, блокировка на 15 минут' },
        },
      },
    },
    '/api/health': {
      get: {
        summary: 'Сводка для дашборда',
        responses: { '200': { description: 'Сводка' }, '401': { description: 'Нужен вход' } },
      },
    },
    '/api/numbers': {
      get: {
        summary: 'Список номеров со статусами и статистикой за сутки',
        responses: {
          '200': {
            description: 'Номера',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Number' } },
              },
            },
          },
        },
      },
      post: {
        summary: 'Добавить номер (создаёт сессию, дальше нужен QR)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', example: 'Отдел продаж 2' },
                  kind: {
                    type: 'string',
                    enum: ['whatsapp', 'telegram', 'max'],
                    default: 'whatsapp',
                  },
                  password: {
                    type: 'string',
                    description:
                      'Только для Телеграма и только если на аккаунте включён ' +
                      'облачный пароль. Нигде не сохраняется — используется ' +
                      'один раз при входе.',
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Созданный номер' } },
      },
    },
    '/api/channel-kinds': {
      get: {
        summary: 'Поддерживаемые мессенджеры и их возможности',
        description:
          'По этому списку админка решает, что показывать при подключении: ' +
          'QR-код, поле для токена или ничего.',
        responses: { '200': { description: 'Список' } },
      },
    },
    '/api/numbers/{id}/qr': {
      get: {
        summary: 'Текущий QR для входа',
        description:
          'Работает одинаково для WhatsApp и Телеграма. Опрашивать раз в 2 секунды: ' +
          'код обновляется сам, а после успешного входа статус канала станет online.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Картинка в виде data-url, вставляется прямо в <img src>',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { qr: { type: 'string' } } },
              },
            },
          },
          '404': { description: 'QR ещё не готов — опросить снова через 2 секунды' },
        },
      },
    },
    '/api/numbers/{id}/restart': {
      post: {
        summary: 'Перезапустить сессию номера',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/numbers/{id}': {
      delete: {
        summary: 'Отвязать номер и удалить его ключи',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/messages': {
      post: {
        summary: 'Отправить сообщение клиенту от лица агента продаж',
        description:
          'Ключ агента в заголовке X-Agent-Token. Адресация по сделке amoCRM. ' +
          'Мессенджер выбирается сам — тот, где разговор шёл последним.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  leadId: { type: 'integer', description: 'Сделка amoCRM' },
                  chatId: { type: 'string', description: 'Переписка, если уже известна' },
                  kind: { type: 'string', enum: ['whatsapp', 'telegram', 'max'] },
                  text: { type: 'string', maxLength: 4096 },
                  idempotencyKey: {
                    type: 'string',
                    description: 'Ключ повтора — обычно id черновика',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Поставлено в очередь' },
          '400': { description: 'Неверный запрос' },
          '401': { description: 'Неверный ключ агента' },
          '403': { description: 'Отправка от агента выключена' },
          '404': { description: 'По сделке нет переписки' },
          '409': { description: 'Такое сообщение уже отправляется' },
          '503': { description: 'Канал не в сети' },
        },
      },
      get: {
        summary: 'Журнал сообщений с фильтрами',
        parameters: [
          { name: 'number', in: 'query', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['received', 'queued', 'sent', 'delivered', 'read', 'failed'],
            },
          },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['in', 'out'] } },
          { name: 'q', in: 'query', description: 'Поиск по телефону или имени контакта' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Сообщения',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/messages/{id}/retry': {
      post: {
        summary: 'Повторить отправку не ушедшего сообщения',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Поставлено в очередь' },
          '404': { description: 'Не найдено' },
          '409': { description: 'Уже доставлено' },
        },
      },
    },
    '/api/settings': {
      get: {
        summary: 'Текущие настройки',
        responses: {
          '200': {
            description: 'Настройки',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Settings' } },
            },
          },
        },
      },
      put: {
        summary: 'Изменить настройки (можно частично)',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Settings' } },
          },
        },
        responses: { '200': { description: 'Новые настройки' }, '400': { description: 'Ошибка' } },
      },
    },
  },
} as const
