import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaintDestination } from '~/composables/usePaintSync'

import { DEFAULT_STACK } from '#shared/utils/layers'
import { useComic } from '~/composables/useComic'
import { forgetMoves, useMoveIn } from '~/composables/useMoveIn'

/**
 * A workspace kept in this window's storage moves into the database whole —
 * `useMoveIn`, desktop.
 *
 * `toCloud` carries the record, the pages, the reading, the translations, the
 * glossary and the cast; what it leaves to "as each page is shown" is what the
 * desktop keeps for good in IndexedDB, and so must go now: every page's layer
 * stack and every page's strokes. Moved too early — a page not hashed yet —
 * and that page's reading stayed behind, which is how the first end-to-end run
 * of this lost it.
 *
 * Seams: `toCloud` and the record (`useShared`), stood in; the stack upload
 * answered by `registerEndpoint`; the paint sync's `upload`, recorded; the
 * stroke logs in IndexedDB, a map of keys.
 */

const { shared, keeping, moves, uploads, logs } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    shared: ref<{ workspace: { publicId: string } } | null>(null),
    keeping: ref<'local' | 'cloud'>('local'),
    moves: { count: 0, ok: true },
    uploads: [] as PaintDestination[],
    /** Stroke logs by `<hash>:<surface>`, each its number of strokes. */
    logs: new Map<string, number>(),
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

mockNuxtImport('useWorkspaceName', () => () => ({
  keeping,
  toCloud: async () => {
    moves.count++

    if (!moves.ok) return false

    shared.value = { workspace: { publicId: 'ws' } }
    keeping.value = 'cloud'

    return true
  },
}))

mockNuxtImport('useShared', () => () => ({
  shared,
  // Page n's row is n.
  pageRowOf: (page: { id: string }) => (shared.value ? Number(page.id.replace(/\D/g, '')) : null),
}))

mockNuxtImport('usePaintCache', () => () => ({
  load: async (store: string) => Array.from({ length: logs.get(store) ?? 0 }, (_, id) => ({ id: -id - 1 })),
}))

mockNuxtImport('idb', () => ({
  keys: async (prefix: string) => [...logs.keys()].map((store) => `paint:${store}`).filter((key) => key.startsWith(prefix)),
}))

vi.mock('~/composables/usePaintSync', () => ({
  usePaintSync: () => ({ upload: (destination: PaintDestination) => { uploads.push(destination) } }),
}))

const stacks: { pageId: number, uids: string[] }[] = []

registerEndpoint('/api/workspaces/ws/layers', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ pageId: number, layers: { uid: string }[] }>(event)

    stacks.push({ pageId: body.pageId, uids: body.layers.map((row) => row.uid) })

    return []
  },
})

/** Page n, its scan hashed (or not yet), on the default stack plus a sheet of its own. */
function page (n: number, hashed = true): ComicPage {
  return {
    id: `scan:${n}.png`,
    name: `${n}.png`,
    blocks: [],
    scan: { url: `blob:${n}`, file: new File([], `${n}.png`), width: 10, height: 10, hash: hashed ? `h${n}` : null },
    stack: [...structuredClone(DEFAULT_STACK), { id: `sheet-${n}`, label: 'Sheet', visible: true, opacity: 100, paint: true }],
  }
}

describe('moveIn', () => {
  beforeEach(() => {
    forgetMoves()
    shared.value = null
    keeping.value = 'local'
    Object.assign(moves, { count: 0, ok: true })
    uploads.length = 0
    stacks.length = 0
    logs.clear()

    const { pages, open } = useComic()

    pages.value = []
    open.value = true
  })

  it('sends every page\'s stack, not only the one on screen', async () => {
    useComic().pages.value = [page(1), page(2)]

    expect(await useMoveIn().moveIn()).toBe(true)
    expect(stacks.map((each) => each.pageId)).toEqual([1, 2])
    expect(stacks[1]!.uids).toContain('sheet-2')
  })

  it('hands the retouching and a sheet\'s strokes to the paint sync — not mask corrections, nor a sheet that is gone', async () => {
    useComic().pages.value = [page(1)]
    logs.set('h1:bg', 2)
    logs.set('h1:sheet-1', 1)
    logs.set('h1:mask-41', 3)
    logs.set('h1:sheet-deleted', 1)

    await useMoveIn().moveIn()

    expect(uploads.map(({ key, plate, layer, pageId, store }) => ({ key, plate, layer, pageId, store }))).toEqual([
      { key: 'bg', plate: 'clean', layer: null, pageId: 1, store: 'h1:bg' },
      { key: 'sheet-1', plate: null, layer: 'sheet-1', pageId: 1, store: 'h1:sheet-1' },
    ])
  })

  it('waits for every page to be hashed — the reading comes back by hash', async () => {
    useComic().pages.value = [page(1), page(2, false)]

    expect(await useMoveIn().moveIn()).toBe(false)
    expect(moves.count).toBe(0)
  })

  it('moves a workspace once, and never one already in the database', async () => {
    useComic().pages.value = [page(1)]

    await useMoveIn().moveIn()
    await useMoveIn().moveIn()

    expect(moves.count).toBe(1)
  })

  it('sends nothing more when the record could not be made, and says so', async () => {
    useComic().pages.value = [page(3)]
    moves.ok = false

    const said = vi.spyOn(toast, 'error')

    expect(await useMoveIn().moveIn()).toBe(false)
    expect(stacks).toEqual([])
    expect(said).toHaveBeenCalledOnce()
  })
})
