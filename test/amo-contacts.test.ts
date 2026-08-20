import { afterEach, describe, expect, it, vi } from 'vitest'
import { findContactByPhone } from '../src/amo/rest-client.js'

/** Подменяет amoCRM: отвечает контактом только на заранее названный запрос. */
function stubAmo(matching: string | null): () => string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const query = decodeURIComponent(new URL(url).searchParams.get('query') ?? '')
    asked.push(query)
    if (matching !== null && query === matching) {
      return Promise.resolve(
        new Response(JSON.stringify({ _embedded: { contacts: [{ id: 7, name: 'Анатолий' }] } }), {
          status: 200,
        }),
      )
    }
    // «Ничего не нашлось» amoCRM отвечает пустым телом с кодом 204.
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  return () => asked
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('поиск контакта по телефону', () => {
  it('находит номер, записанный в карточке без кода страны', async () => {
    const asked = stubAmo('9660388883')
    const contact = await findContactByPhone('79660388883')
    expect(contact?.id).toBe(7)
    expect(asked()).toEqual(['79660388883', '9660388883'])
  })

  it('лишнего запроса не делает, если нашёлся сразу', async () => {
    const asked = stubAmo('79660388883')
    expect((await findContactByPhone('+7 (966) 038-88-83'))?.id).toBe(7)
    expect(asked()).toEqual(['79660388883'])
  })

  it('не нашёлся — значит контакта нет', async () => {
    stubAmo(null)
    expect(await findContactByPhone('79660388883')).toBeNull()
  })

  it('без телефона в amoCRM не ходим', async () => {
    const asked = stubAmo(null)
    expect(await findContactByPhone('')).toBeNull()
    expect(asked()).toEqual([])
  })
})
