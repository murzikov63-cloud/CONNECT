/**
 * Вход в Телеграм в два шага — код приходит между ними, поэтому одной
 * командой не обойтись.
 *
 *   npx tsx scripts/telegram-login.ts start "Отдел продаж" +79991234567
 *   npx tsx scripts/telegram-login.ts code <id-канала> 12345 [облачный-пароль]
 *
 * После успешного входа строка сессии ложится в базу и попадает
 * в ежедневный бэкап вместе с ней.
 */
import { config } from '../src/config/index.js'
import { closeDb, sql } from '../src/db/index.js'
import { loadPending, savePending, saveSession } from '../src/telegram/auth-state.js'
import { Api, StringSession, TelegramClient } from '../src/telegram/gramjs.js'

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

function requireKeys(): void {
  if (config.TG_API_ID === 0 || config.TG_API_HASH === '') {
    console.error('В .env не заданы TG_API_ID и TG_API_HASH.')
    console.error('Где их взять — docs/anatoly/05-telegram-connect.md')
    process.exit(1)
  }
}

function makeClient(session: string): any {
  const client = new TelegramClient(
    new StringSession(session),
    config.TG_API_ID,
    config.TG_API_HASH,
    { connectionRetries: 5 },
  )
  client.setLogLevel?.('error')
  return client
}

async function start(label: string, phone: string): Promise<void> {
  requireKeys()

  const rows = await sql<{ id: string }[]>`
    insert into channels (kind, label, phone, status)
    values ('telegram', ${label}, ${phone.replace(/\D/g, '')}, 'connecting')
    returning id
  `
  const channelId = rows[0]?.id
  if (channelId === undefined) throw new Error('не удалось создать канал')

  const client = makeClient('')
  await client.connect()

  const { phoneCodeHash } = await client.sendCode(
    { apiId: config.TG_API_ID, apiHash: config.TG_API_HASH },
    phone,
  )

  await savePending(channelId, {
    phone,
    phoneCodeHash,
    // Сессию надо сохранить именно сейчас: код привязан к этому соединению,
    // и с чистой сессией второй шаг его не примет.
    session: client.session.save() as string,
  })
  await client.disconnect()

  console.log('\nКод отправлен в Телеграм на номер ' + phone)
  console.log('Канал создан, его идентификатор:\n')
  console.log(`  ${channelId}\n`)
  console.log('Второй шаг:')
  console.log(`  npx tsx scripts/telegram-login.ts code ${channelId} <код> [облачный-пароль]`)
}

async function code(channelId: string, phoneCode: string, password?: string): Promise<void> {
  requireKeys()

  const pending = await loadPending(channelId)
  if (pending === null) {
    console.error('Для этого канала не начинали вход. Сначала выполните шаг start.')
    process.exit(1)
  }

  const client = makeClient(pending.session)
  await client.connect()

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode,
      }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (message.includes('SESSION_PASSWORD_NEEDED')) {
      if (password === undefined) {
        console.error('\nНа аккаунте включён облачный пароль. Повторите с ним:')
        console.error(`  npx tsx scripts/telegram-login.ts code ${channelId} ${phoneCode} <пароль>`)
        await client.disconnect()
        process.exit(1)
      }
      await client.signInWithPassword(
        { apiId: config.TG_API_ID, apiHash: config.TG_API_HASH },
        { password: async () => password, onError: (e: Error) => { throw e } },
      )
    } else if (message.includes('PHONE_CODE_INVALID')) {
      console.error('\nКод неверный. Проверьте и повторите.')
      await client.disconnect()
      process.exit(1)
    } else if (message.includes('PHONE_CODE_EXPIRED')) {
      console.error('\nКод устарел. Начните заново с шага start.')
      await client.disconnect()
      process.exit(1)
    } else {
      throw err
    }
  }

  const me = await client.getMe()
  await saveSession(channelId, client.session.save() as string)
  await sql`
    update channels set status = 'offline', phone = ${String(me?.phone ?? '').replace(/\D/g, '')},
      external_id = ${String(me?.id ?? '')}, updated_at = now()
    where id = ${channelId}
  `
  await client.disconnect()

  const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ')
  console.log(`\nГотово. Вошли как ${name} (${me?.phone ?? '—'}).`)
  console.log('Перезапустите сервис, чтобы канал поднялся:')
  console.log('  docker compose up -d --force-recreate app')
}

const [command, ...rest] = process.argv.slice(2)

try {
  if (command === 'start' && rest.length >= 2) {
    await start(rest[0]!, rest[1]!)
  } else if (command === 'code' && rest.length >= 2) {
    await code(rest[0]!, rest[1]!, rest[2])
  } else {
    console.error('Как пользоваться:')
    console.error('  npx tsx scripts/telegram-login.ts start "Название" +79991234567')
    console.error('  npx tsx scripts/telegram-login.ts code <id-канала> 12345 [облачный-пароль]')
    process.exit(1)
  }
} finally {
  await closeDb()
}
