import { afterEach, describe, expect, it, vi } from 'vitest'
import { outgoingLocalFile } from '../src/wa/media.js'

const КАНАЛ = '11111111-1111-1111-1111-111111111111'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('вложение перед отправкой', () => {
  it('ссылку из amoCRM скачиваем себе', async () => {
    // Мессенджеру ссылку давать нельзя: хранилище amoCRM закрыто,
    // и Телеграм отвечает WEBPAGE_CURL_FAILED.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      ),
    )
    const путь = await outgoingLocalFile(КАНАЛ, {
      mediaPath: 'https://drive-a.amocrm.ru/download/abc',
      mediaName: 'КП для клиента.pdf',
    })
    expect(путь).toContain(КАНАЛ)
    expect(путь?.startsWith('/')).toBe(true)
  })

  it('свой файл отдаём как есть, без скачивания', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('сеть не нужна')))
    const путь = await outgoingLocalFile(КАНАЛ, { mediaPath: 'папка/файл.jpg' })
    expect(путь?.endsWith('папка/файл.jpg')).toBe(true)
  })

  it('без вложения ничего не готовим', async () => {
    expect(await outgoingLocalFile(КАНАЛ, {})).toBeUndefined()
  })

  it('отказ хранилища виден в причине, а не молчанием', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 403 })))
    await expect(
      outgoingLocalFile(КАНАЛ, { mediaPath: 'https://drive-a.amocrm.ru/download/abc' }),
    ).rejects.toThrow(/403/)
  })
})
