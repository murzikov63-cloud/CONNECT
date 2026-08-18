import { describe, expect, it } from 'vitest'
import { extForMime, mediaToken, mediaUrl, verifyMediaToken } from '../src/wa/media.js'

describe('extForMime', () => {
  it('знает основные типы', () => {
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('application/pdf')).toBe('pdf')
    expect(extForMime('audio/ogg; codecs=opus')).toBe('ogg')
  })

  it('незнакомый тип получает bin', () => {
    expect(extForMime('application/x-nonsense')).toBe('bin')
  })
})

describe('подписанные ссылки на вложения', () => {
  const rel = 'num-1/2026-08/WAMSG1.jpg'

  it('подпись стабильна и проверяется', () => {
    const t = mediaToken(rel)
    expect(t).toHaveLength(32)
    expect(verifyMediaToken(rel, t)).toBe(true)
  })

  it('чужая подпись не проходит', () => {
    expect(verifyMediaToken(rel, mediaToken('другой/путь.jpg'))).toBe(false)
    expect(verifyMediaToken(rel, '')).toBe(false)
  })

  it('ссылка ведёт на публичный домен', () => {
    expect(mediaUrl(rel)).toContain('https://connect.example.com/media/')
  })
})
