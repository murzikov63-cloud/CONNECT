import { beforeEach, describe, expect, it } from 'vitest'
import {
  issueToken,
  loginBlocked,
  parseCorsOrigins,
  registerFailure,
  registerSuccess,
  resetLoginLimiter,
  verifyToken,
} from '../src/api/auth.js'

describe('токен входа', () => {
  it('свежий токен принимается', () => {
    const { token } = issueToken()
    expect(verifyToken(token)).toBe(true)
  })

  it('просроченный токен не принимается', () => {
    const now = Date.now()
    const { token, expiresAt } = issueToken(now)
    expect(verifyToken(token, expiresAt + 1)).toBe(false)
  })

  it('подделанный срок жизни не проходит', () => {
    const { token } = issueToken()
    const signature = token.slice(token.indexOf('.') + 1)
    const forged = `${Date.now() + 10 ** 9}.${signature}`
    expect(verifyToken(forged)).toBe(false)
  })

  it('испорченная подпись не проходит', () => {
    const { token } = issueToken()
    expect(verifyToken(`${token}x`)).toBe(false)
  })

  it('мусор вместо токена не роняет проверку', () => {
    for (const junk of ['', '.', 'abc', '....', '123.']) {
      expect(verifyToken(junk)).toBe(false)
    }
  })
})

describe('ограничитель попыток входа', () => {
  beforeEach(() => resetLoginLimiter())

  it('пропускает первые попытки и блокирует после пяти', () => {
    const ip = '203.0.113.7'
    for (let i = 0; i < 5; i++) {
      expect(loginBlocked(ip)).toBe(false)
      registerFailure(ip)
    }
    expect(loginBlocked(ip)).toBe(true)
  })

  it('удачный вход снимает счётчик', () => {
    const ip = '203.0.113.8'
    for (let i = 0; i < 5; i++) registerFailure(ip)
    expect(loginBlocked(ip)).toBe(true)
    registerSuccess(ip)
    expect(loginBlocked(ip)).toBe(false)
  })

  it('блокировка не задевает другие адреса', () => {
    for (let i = 0; i < 5; i++) registerFailure('203.0.113.9')
    expect(loginBlocked('203.0.113.10')).toBe(false)
  })

  it('через 15 минут блокировка отпускает', () => {
    const ip = '203.0.113.11'
    const now = Date.now()
    for (let i = 0; i < 5; i++) registerFailure(ip, now)
    expect(loginBlocked(ip, now)).toBe(true)
    expect(loginBlocked(ip, now + 15 * 60 * 1000 + 1)).toBe(false)
  })
})

describe('разбор списка разрешённых источников', () => {
  it('точный адрес остаётся строкой', () => {
    expect(parseCorsOrigins('https://app.example.com')).toEqual(['https://app.example.com'])
  })

  it('звёздочка превращается в шаблон и ловит поддомены', () => {
    const [pattern] = parseCorsOrigins('https://*.lovable.app')
    expect(pattern).toBeInstanceOf(RegExp)
    expect((pattern as RegExp).test('https://my-app.lovable.app')).toBe(true)
    expect((pattern as RegExp).test('https://lovable.app')).toBe(false)
  })

  it('шаблон не пропускает чужой домен с похожим концом', () => {
    const [pattern] = parseCorsOrigins('https://*.lovable.app')
    expect((pattern as RegExp).test('https://evil.com/x.lovable.app')).toBe(false)
    expect((pattern as RegExp).test('https://lovable.app.evil.com')).toBe(false)
  })

  it('точка в домене не работает как «любой символ»', () => {
    const [pattern] = parseCorsOrigins('https://*.lovable.app')
    expect((pattern as RegExp).test('https://a.lovableXapp')).toBe(false)
  })

  it('пустая настройка даёт пустой список — значит доступ закрыт', () => {
    expect(parseCorsOrigins('')).toEqual([])
    expect(parseCorsOrigins('  ,  ')).toEqual([])
  })

  it('несколько источников через запятую', () => {
    expect(parseCorsOrigins('https://a.com, https://b.com')).toHaveLength(2)
  })
})
