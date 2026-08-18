import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { rfc2822Date, signRequest } from '../src/amo/signature.js'

describe('rfc2822Date', () => {
  it('даёт формат, который ждёт amoCRM', () => {
    const d = new Date(Date.UTC(2026, 7, 18, 5, 4, 3))
    expect(rfc2822Date(d)).toBe('Tue, 18 Aug 2026 05:04:03 +0000')
  })

  it('не подставляет GMT вместо смещения', () => {
    expect(rfc2822Date(new Date())).toMatch(/ \+0000$/)
  })

  it('дополняет однозначные числа нулём', () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(rfc2822Date(d)).toBe('Fri, 02 Jan 2026 03:04:05 +0000')
  })
})

describe('signRequest', () => {
  const secret = 'секретный-ключ'
  const body = JSON.stringify({ account_id: 'abc', title: 'Messenger' })
  const path = '/v2/origin/custom/CHANNEL/connect'
  const date = new Date(Date.UTC(2026, 7, 18, 5, 0, 0))

  it('собирает все четыре заголовка', () => {
    const h = signRequest('POST', path, body, secret, date)
    expect(Object.keys(h).sort()).toEqual([
      'Content-MD5',
      'Content-Type',
      'Date',
      'X-Signature',
    ])
  })

  it('Content-MD5 — это md5 тела в нижнем регистре', () => {
    const h = signRequest('POST', path, body, secret, date)
    expect(h['Content-MD5']).toBe(createHash('md5').update(body).digest('hex'))
    expect(h['Content-MD5']).toBe(h['Content-MD5'].toLowerCase())
  })

  it('подпись считается по документированной склейке', () => {
    const h = signRequest('POST', path, body, secret, date)
    const md5 = createHash('md5').update(body).digest('hex')
    const expected = createHmac('sha1', secret)
      .update(['POST', md5, 'application/json', rfc2822Date(date), path].join('\n'))
      .digest('hex')
    expect(h['X-Signature']).toBe(expected)
  })

  it('метод приводится к верхнему регистру', () => {
    const a = signRequest('post', path, body, secret, date)
    const b = signRequest('POST', path, body, secret, date)
    expect(a['X-Signature']).toBe(b['X-Signature'])
  })

  it('любое изменение тела меняет подпись', () => {
    const a = signRequest('POST', path, body, secret, date)
    const b = signRequest('POST', path, `${body} `, secret, date)
    expect(a['X-Signature']).not.toBe(b['X-Signature'])
  })

  it('любое изменение пути меняет подпись', () => {
    const a = signRequest('POST', path, body, secret, date)
    const b = signRequest('POST', `${path}x`, body, secret, date)
    expect(a['X-Signature']).not.toBe(b['X-Signature'])
  })
})
