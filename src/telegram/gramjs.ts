/**
 * Единственная точка импорта GramJS — библиотеки для работы с Телеграмом
 * от лица обычного аккаунта.
 *
 * Причина та же, что и у обёртки вокруг Baileys: пакет собран как CommonJS
 * и не объявляет карту экспортов, поэтому обращения вида `telegram/sessions`
 * из нашего ESM-кода не разрешаются. Берём через createRequire.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* eslint-disable @typescript-eslint/no-explicit-any */
const core = require('telegram') as any
const sessions = require('telegram/sessions') as any
const events = require('telegram/events') as any
const errors = require('telegram/errors') as any

export const TelegramClient = core.TelegramClient
export const Api = core.Api
export const StringSession = sessions.StringSession
export const NewMessage = events.NewMessage
export const RPCError = errors.RPCError
// Телеграм считает идентификаторы длинными числами, которые не помещаются
// в обычный тип: библиотека ждёт именно эти объекты.
export const bigInt = require('big-integer') as (value: number | string) => unknown

export type TgClient = any
export type TgMessage = any

if (typeof TelegramClient !== 'function' || typeof StringSession !== 'function') {
  throw new Error(
    'Не удалось получить TelegramClient из пакета telegram — проверьте версию библиотеки',
  )
}
