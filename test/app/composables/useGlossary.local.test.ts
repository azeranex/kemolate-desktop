import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { keepCastLocally, localCast } from '~/composables/useCast'
import { keepGlossaryLocally, localGlossaries } from '~/composables/useGlossary'

/**
 * A local workspace's glossary and cast, kept in this browser.
 *
 * Both used to live only on the server, so a local workspace had neither — it
 * got them by being claimed on its first translation, which the reader never
 * chose. These pin the browser-side store: terms fold in first-translation-wins
 * exactly as the server's do, a cast is kept whole and pinned, and each
 * workspace's lists are its own.
 *
 * IndexedDB is swapped for a map. The store's rules are the thing under test,
 * not the browser's database.
 */
const { memory } = vi.hoisted(() => ({ memory: new Map<string, unknown>() }))

// A local workspace: an address, and no record on the server.
mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-a' }, fullPath: '/w/ws-a' }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
  getMany: async (keys: string[]) => keys.map((key) => memory.get(key)),
}))

describe('a local workspace\'s glossary', () => {
  beforeEach(() => memory.clear())

  it('keeps the first translation of a name', async () => {
    await keepGlossaryLocally('ws-a', { locale: 'en', terms: [{ source: '宗介', target: 'Sosuke' }] })
    await keepGlossaryLocally('ws-a', { locale: 'en', terms: [{ source: '宗介', target: 'Sousuke' }, { source: '千鳥', target: 'Chidori' }] })

    expect(await localGlossaries('ws-a')).toEqual([
      { locale: 'en', terms: [{ source: '宗介', target: 'Sosuke' }, { source: '千鳥', target: 'Chidori' }] },
    ])
  })

  it('keeps one list per language and per workspace', async () => {
    await keepGlossaryLocally('ws-a', { locale: 'en', terms: [{ source: '宗介', target: 'Sousuke' }] })
    await keepGlossaryLocally('ws-a', { locale: 'id', terms: [{ source: '宗介', target: 'Sosuke' }] })
    await keepGlossaryLocally('ws-b', { locale: 'en', terms: [{ source: '千鳥', target: 'Chidori' }] })

    expect((await localGlossaries('ws-a')).map((glossary) => glossary.locale).sort()).toEqual(['en', 'id'])
    expect(await localGlossaries('ws-b')).toHaveLength(1)
  })
})

describe('a local workspace\'s cast', () => {
  beforeEach(() => memory.clear())

  it('is kept whole, every member pinned', async () => {
    await keepCastLocally('ws-a', [{ source: '宗介', names: { en: 'Sousuke' }, gender: 'male' }, { source: '' }], 'Formal register.')

    const cast = await localCast('ws-a')

    expect(cast.notes).toBe('Formal register.')
    expect(cast.members).toHaveLength(1)
    expect(cast.members[0]).toMatchObject({ source: '宗介', gender: 'male', pinned: true })
  })
})

describe('useGlossary on a local workspace', () => {
  beforeEach(() => {
    memory.clear()
    useState('workspace-shared').value = null
  })

  it('is available and writable with no server record', () => {
    const { available, writable } = useGlossary()

    expect(available.value).toBe(true)
    expect(writable.value).toBe(true)
  })

  it('learns, corrects and forgets terms in this browser', async () => {
    const { learn, set, forget, load, terms } = useGlossary()

    await learn([{ src: '宗介', tr: 'Sosuke' }, { src: 'OK', tr: 'OK' }])
    expect(terms.value.map((term) => term.target)).toEqual(['Sosuke'])

    // A person's own rendering overwrites, unlike the model's.
    await set('宗介', 'Sousuke')
    await load()
    expect(terms.value.map((term) => term.target)).toEqual(['Sousuke'])

    await forget(terms.value[0]!.id)
    expect(await load()).toEqual([])
  })
})

describe('useCast on a local workspace', () => {
  beforeEach(() => {
    memory.clear()
    useState('workspace-shared').value = null
  })

  it('learns a member, then leaves them alone once saved', async () => {
    const { learn, save, members, load } = useCast()

    await learn([{ name: '宗介', tr: 'Sousuke' }], 'en')
    expect(members.value[0]).toMatchObject({ source: '宗介', gender: 'unknown', pinned: false })

    await save([{ source: '宗介', names: { en: 'Sousuke' }, gender: 'male' }], '')
    await learn([{ name: '宗介', gender: 'female' }], 'en')
    await load()

    // Saved is pinned, and a pinned member is not argued with.
    expect(members.value[0]).toMatchObject({ gender: 'male', pinned: true })
  })
})
