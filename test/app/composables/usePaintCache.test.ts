import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isProxy, toRaw } from 'vue'

import type { LocalStroke } from '~/composables/usePaintCache'

import { usePaintCache } from '~/composables/usePaintCache'

/**
 * The local stroke log keeps its rows out of Vue's reach.
 *
 * The report: every save re-serialised the whole page's log through Vue's
 * proxies — a JSON round trip, because structured clone refuses a proxy — and
 * a save follows every stroke. On a surface of 400 strokes that was 55 to 136
 * ms of the main thread after each mark, by the length of the strokes, and in
 * development Nuxt's payload watcher walked every point again on every
 * `useState` write in the app. The rows are `markRaw` now and the list is
 * handed to the store unwrapped.
 *
 * Seam: `usePaintCache` over a store that clones what it is given, as
 * IndexedDB does — so a proxy reaching it fails the way it would in a browser.
 */
const { written } = vi.hoisted(() => ({ written: [] as { key: string, value: { v: number, strokes: LocalStroke[] } }[] }))

mockNuxtImport('idb', () => ({
  get: async () => undefined,
  set: async (key: string, value: { v: number, strokes: LocalStroke[] }) => {
    structuredClone(value)
    written.push({ key, value })
  },
  del: async () => {},
  keys: async () => [],
  getMany: async (keys: string[]) => keys.map(() => undefined),
}))

const draft = (seq: number) => ({
  seq,
  clientId: 'me',
  tool: 'brush',
  composite: null,
  params: { size: 20, colour: '#ffffff' },
  points: [10, 10, 40, 40, 80, 80],
  x: 0,
  y: 0,
  w: 90,
  h: 90,
})

const past = () => new Promise((resolve) => setTimeout(resolve, 320))

describe('the local stroke log', () => {
  beforeEach(() => {
    usePaintCache().strokes.value = {}
    written.length = 0
  })

  it('hands out rows Vue does not watch, however they came to be there', async () => {
    const paint = usePaintCache()

    paint.add('h1:bg', draft(1))

    const [laid] = paint.on('h1:bg')

    paint.retract(laid!.id, true)
    await paint.seed('h1', 'bg', [{ ...draft(2), retracted: false }])

    const rows = paint.on('h1:bg')

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => isProxy(row))).toEqual([false, false])
    expect(rows.map((row) => isProxy(row.points))).toEqual([false, false])
  })

  /*
   * What a save costs is what it copies. The rows go to the store as they are
   * held — the very objects — rather than as a copy walked out of proxies.
   */
  it('writes the rows it holds to the store as they are, not a copy of them', async () => {
    const paint = usePaintCache()

    paint.add('h2:bg', draft(1))
    paint.add('h2:bg', draft(2))
    await past()

    const saved = written.filter((entry) => entry.key.endsWith('h2:bg')).at(-1)

    expect(saved).toBeDefined()
    expect(saved!.value.strokes).toHaveLength(2)
    expect(saved!.value.strokes[0]).toBe(toRaw(paint.on('h2:bg'))[0])
  })
})
