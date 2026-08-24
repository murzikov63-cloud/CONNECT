import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signatureIsDecidable, verifyWebhookSignature } from '../src/amo/webhook.js'

const SECRET = 'секрет-канала'

/** Так подпись считает amoCRM: от JSON в экранированном виде. */
function подписатьПоАмошному(данные: unknown): string {
  const экранированный = JSON.stringify(данные).replace(/\//g, '\\/')
  return createHmac('sha1', SECRET).update(экранированный).digest('hex')
}

describe('подпись вебхука amoCRM', () => {
  it('сходится, когда в переписке русские буквы', () => {
    // Главный случай: amoCRM подписывает «Зд...», а присылает
    // обычный текст. Раньше на этом всё и ломалось.
    const данные = { message: { text: 'Здравствуйте, а сколько стоит?' } }
    const тело = JSON.stringify(данные)
    expect(verifyWebhookSignature(SECRET, тело, подписатьПоАмошному(данные))).toBe(true)
  })

  it('сходится, когда внутри ссылки с косыми чертами', () => {
    const данные = { avatar: 'https://connect.indolight.com/media/a/b.jpg' }
    const тело = JSON.stringify(данные)
    expect(verifyWebhookSignature(SECRET, тело, подписатьПоАмошному(данные))).toBe(true)
  })

  it('сходится и по-простому, если тело без русских букв и косых черт', () => {
    const тело = '{"a":1}'
    const прямая = createHmac('sha1', SECRET).update(тело).digest('hex')
    expect(verifyWebhookSignature(SECRET, тело, прямая)).toBe(true)
  })

  it('чужую подпись не принимает', () => {
    const тело = JSON.stringify({ message: { text: 'Привет' } })
    expect(verifyWebhookSignature(SECRET, тело, 'a'.repeat(40))).toBe(false)
    expect(verifyWebhookSignature('другой-секрет', тело, подписатьПоАмошному({ message: { text: 'Привет' } }))).toBe(false)
  })

  it('без подписи или без секрета — не принимает', () => {
    expect(verifyWebhookSignature(SECRET, '{}', '')).toBe(false)
    expect(verifyWebhookSignature('', '{}', 'что-то')).toBe(false)
  })

  it('о неразбираемом теле судить не берётся', () => {
    // Такой запрос отклонять нельзя: вид, от которого считали подпись,
    // нам неизвестен, и это может быть законный ответ менеджера.
    expect(signatureIsDecidable('не json')).toBe(false)
    expect(signatureIsDecidable('{"a":1}')).toBe(true)
  })
})
