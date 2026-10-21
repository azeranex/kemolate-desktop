import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import type { StackLayer } from '#shared/utils/layers'

import { DEFAULT_STACK } from '#shared/utils/layers'
import { useComic } from '~/composables/useComic'
import { useLayerClaims, useLayerSync } from '~/composables/useLayerSync'

/**
 * Turning pages must never save a layer stack nobody edited.
 *
 * The report: a whole chapter's Dialogue, SFX and mask visibility came out
 * alternating between the Clean and Letter arrangements after its pages were
 * turned through quickly — one save per page turn, and the damage following the
 * direction the pages were turned in. The chapter had been set to Clean a
 * moment before, which rewrote every page on the server, while the tab doing
 * the turning still held older stacks in memory for pages it had shown.
 *
 * Two things together. Arriving at a page this tab had not yet agreed with the
 * server read as an edit, because the stack on screen changed and there was
 * nothing to compare it to, so a save was scheduled for a page nobody had
 * touched. And a save still waiting when the page turned again was sent
 * "against the page it was drawn on" — with the rows of the page now on screen,
 * because `send` read whatever `layers` held when it ran. So each quick turn
 * wrote the page arrived at onto the page before it.
 *
 * Seam: what `useLayerSync` asks the server to write as the page turns, and what
 * each page ends up showing — the server answered by `registerEndpoint`, which is
 * the boundary (the app's `$fetch` is the test environment's own, so stubbing the
 * global does not reach it). The page turn is `useComic`'s own `at`. Real timers:
 * the settle is 600 ms and the tests wait it out.
 */

// A real ref: `useLayerSync` watches it, and a watcher on a plain object never fires.
const { shared, standing } = await vi.hoisted(async () => {
  const { computed, ref } = await import('vue')
  const shared = ref<unknown>(null)

  // What `useShared.standing` is: set exactly when a record is in hand.
  return { shared, standing: computed(() => (shared.value ? 'ws:editor' : null)) }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({
  shared,
  standing,
  // Null until the record lands, as `useShared.pageRowOf` is: it reads the
  // workspace's own page list, so a page opened from this browser's storage
  // before the server has answered has no row yet.
  pageRowOf: (page: { id: string }) => (shared.value
    ? ({ 'page-a': 1, 'page-b': 2 } as Record<string, number>)[page.id] ?? null
    : null),
}))

/** The Clean arrangement and the Letter one, on the standard stack. */
const arranged = (letter: boolean): StackLayer[] => {
  const stack = structuredClone(DEFAULT_STACK)
  const walk = (rows: StackLayer[]) => {
    for (const row of rows) {
      if (row.id === 'dialogue' || row.id === 'sfx') row.visible = letter
      if (row.id === 'mask') row.visible = !letter

      walk(row.children ?? [])
    }
  }

  walk(stack)

  return stack
}

/** A stack as the server files it: numbered rows naming their parent. */
function stored (stack: StackLayer[], page: number) {
  let id = page * 100
  const out: Record<string, unknown>[] = []
  const walk = (rows: StackLayer[], parentId: number | null) => {
    rows.forEach((row, position) => {
      const mine = ++id

      out.push({
        id: mine,
        uid: row.id,
        parentId,
        position,
        label: row.label,
        hint: row.hint ?? null,
        plate: row.plate ?? null,
        visible: row.visible,
        opacity: row.opacity,
        locked: row.locked ?? false,
        paint: false,
        fixed: row.fixed ?? false,
        clipped: false,
        adjust: null,
        image: null,
      })
      walk(row.children ?? [], mine)
    })
  }

  walk(stack, null)

  return out
}

/**
 * The Final arrangement: shown exactly as `DEFAULT_STACK` is, with the lettering
 * and the repair locked. So a default stack written over it moves the locks and
 * nothing else — which is what the istani chapter came back with.
 */
const finished = (): StackLayer[] => {
  const stack = structuredClone(DEFAULT_STACK)
  const walk = (rows: StackLayer[]) => {
    for (const row of rows) {
      if (row.id === 'dialogue' || row.id === 'sfx' || row.id === 'clean') row.locked = true

      walk(row.children ?? [])
    }
  }

  walk(stack)

  return stack
}

const rowIn = (stack: StackLayer[] | undefined, id: string): StackLayer | undefined => {
  for (const row of stack ?? []) {
    if (row.id === id) return row

    const inside = rowIn(row.children, id)

    if (inside) return inside
  }

  return undefined
}

const visibleOf = (stack: StackLayer[] | undefined, id: string) => rowIn(stack, id)?.visible
const lockedOf = (stack: StackLayer[] | undefined, id: string) => rowIn(stack, id)?.locked ?? false

/** Let promises, watchers and the stubbed server all answer. */
async function settle () {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await nextTick()
  }
}

/** What the page turns asked the server to write, in order. */
const puts: { pageId: number, layers: { uid: string, visible: boolean, locked: boolean }[] }[] = []

/** What the server holds on every page. Clean unless a test says otherwise. */
let filed: () => StackLayer[] = () => arranged(false)

/** Pages the server holds no stack for — looked at, and never changed. */
const bare = new Set<number>()

// The server: Clean on every page, as a chapter-wide preset left it.
registerEndpoint('/api/workspaces/ws/layers', {
  method: 'GET',
  handler: (event) => {
    const pageId = Number(getQuery(event).pageId)

    return bare.has(pageId) ? [] : stored(filed(), pageId)
  },
})
registerEndpoint('/api/workspaces/ws/layers', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ pageId: number, layers: { uid: string, visible: boolean, locked: boolean }[] }>(event)

    puts.push({ pageId: body.pageId, layers: body.layers })

    return stored(filed(), body.pageId)
  },
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Past a settle, with every request answered. */
async function outlast () {
  await wait(900)
  await settle()
}

describe('turning pages', () => {
  // One per test: a stopped scope runs nothing, silently.
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    filed = () => arranged(false)

    // This tab: both pages still held in memory as they were before the preset.
    const { pages, at } = useComic()

    pages.value = [
      { id: 'page-a', name: 'a.jpg', blocks: [], stack: arranged(true) },
      { id: 'page-b', name: 'b.jpg', blocks: [], stack: arranged(true) },
    ] as never
    at.value = 0

    shared.value = { role: 'editor', pages: [] }
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
  })

  it('saves nothing when pages are only looked at, and shows each page as the server has it', async () => {
    const { pages, at } = useComic()

    scope.run(() => useLayerSync())
    await settle()

    // Across and back, faster than a settle.
    at.value = 1
    await settle()
    at.value = 0
    await settle()
    await outlast()

    expect(puts).toEqual([])
    expect(visibleOf(pages.value[1]!.stack, 'dialogue')).toBe(false)
    expect(visibleOf(pages.value[0]!.stack, 'dialogue')).toBe(false)
  })

  it('saves an edit against the page it was made on, with that page\'s rows', async () => {
    const { pages, at, layers } = useComic()

    scope.run(() => useLayerSync())
    await settle()

    at.value = 1
    await settle()
    await outlast()

    // An edit on page B — the mask turned off — and away before it settles.
    layers.value = layers.value.map((row) => row.id === 'cleanup'
      ? { ...row, children: row.children!.map((child) => child.id === 'mask' ? { ...child, visible: false } : child) }
      : row)
    await settle()

    at.value = 0
    await settle()
    await outlast()

    const onB = puts.filter((put) => put.pageId === 2)
    const onA = puts.filter((put) => put.pageId === 1)

    expect(onB).toHaveLength(1)
    expect(onB[0]!.layers.find((row) => row.uid === 'mask')?.visible).toBe(false)
    expect(onA).toEqual([])
    expect(visibleOf(pages.value[1]!.stack, 'mask')).toBe(false)
  })
})

/**
 * Opening a workspace must not save the stack a page was opened with.
 *
 * The report: the istani chapter, finished and set to Final, came back with
 * Dialogue, SFX and the cleaned plate unlocked on the pages an automated run had
 * been looking at — and nothing else changed, because the Final arrangement is
 * `DEFAULT_STACK` with those three rows locked. Every page this browser opens
 * starts on `DEFAULT_STACK` until `pull` says otherwise, so a save sent before
 * the pull lands is the default written over the page.
 *
 * The chapter opens from this browser's own storage, which is quicker than the
 * server's record of it. When the record lands, the page acquires its row and
 * the workspace becomes writable in the same tick, and neither is an edit — but
 * the stack watcher read the second as one, and the page watcher then sent the
 * save it had just scheduled "against the page it was drawn on".
 */
describe('arriving at a workspace', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    filed = finished

    const { pages, at } = useComic()

    // Opened from storage, as every page is: founded on the default stack.
    pages.value = [
      { id: 'page-a', name: 'a.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
      { id: 'page-b', name: 'b.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
    ] as never
    at.value = 0

    // The record has not answered yet.
    shared.value = null
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
  })

  it('saves nothing when the record lands on a page already open, and shows the page\'s locks', async () => {
    const { pages } = useComic()

    scope.run(() => useLayerSync())
    await settle()

    shared.value = { role: 'editor', pages: [] }
    await settle()
    await outlast()

    expect(puts).toEqual([])
    expect(lockedOf(pages.value[0]!.stack, 'dialogue')).toBe(true)
    expect(lockedOf(pages.value[0]!.stack, 'clean')).toBe(true)
  })

  it('saves nothing when the chapter is opened again under the same page ids', async () => {
    const { pages, at, epoch } = useComic()

    shared.value = { role: 'editor', pages: [] }

    scope.run(() => useLayerSync())
    await settle()
    await outlast()

    expect(lockedOf(pages.value[0]!.stack, 'dialogue')).toBe(true)

    // What `openImages` does: new pages, the same ids, each on the default
    // stack — the page on screen keeps its key and its row.
    pages.value = [
      { id: 'page-a', name: 'a.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
      { id: 'page-b', name: 'b.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
    ] as never
    at.value = 0
    epoch.value++
    await settle()
    await outlast()

    expect(puts).toEqual([])
    expect(lockedOf(pages.value[0]!.stack, 'dialogue')).toBe(true)
  })

  it('still saves a lock taken off by hand once the page has been read back', async () => {
    const { pages, setLayerLocked } = useComic()

    shared.value = { role: 'editor', pages: [] }

    scope.run(() => useLayerSync())
    await settle()
    await outlast()

    setLayerLocked('dialogue', false)
    await settle()
    await outlast()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.pageId).toBe(1)
    expect(puts[0]!.layers.find((row) => row.uid === 'dialogue')?.locked).toBe(false)
    expect(puts[0]!.layers.find((row) => row.uid === 'clean')?.locked).toBe(true)
    expect(lockedOf(pages.value[0]!.stack, 'dialogue')).toBe(false)
  })
})

/**
 * A page the server holds no stack for is a page nobody has changed.
 *
 * Looking used to found one: this sent what was on screen the moment it read
 * an empty answer, and a paint canvas connecting founded the stack anyway — so
 * every page anybody turned to was written on for having been looked at. Now
 * an empty answer is taken as the default it would have been founded with, and
 * the page's rows are written the first time somebody changes something.
 *
 * What must survive that: a stack the server has never seen still goes up on
 * arrival — one carried from a local workspace moved to the cloud, or one a
 * project file brought, whose claim is spent here as anywhere else.
 */
describe('a page the server has no stack for', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    filed = () => structuredClone(DEFAULT_STACK)
    bare.clear()
    bare.add(2)
    useLayerClaims().value = []

    const { pages, at } = useComic()

    pages.value = [
      { id: 'page-a', name: 'a.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
      { id: 'page-b', name: 'b.jpg', blocks: [], stack: structuredClone(DEFAULT_STACK) },
    ] as never
    at.value = 0

    shared.value = { role: 'editor', pages: [] }
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
    bare.clear()
  })

  it('writes nothing for it on arrival, and saves the first edit made to it', async () => {
    const { at, setLayerLocked } = useComic()

    scope.run(() => useLayerSync())
    await settle()

    at.value = 1
    await settle()
    await outlast()

    expect(puts).toEqual([])

    setLayerLocked('dialogue', true)
    await settle()
    await outlast()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.pageId).toBe(2)
    expect(puts[0]!.layers.find((row) => row.uid === 'dialogue')?.locked).toBe(true)
  })

  it('sends a stack it has never seen, once — one carried up from a local workspace', async () => {
    const { pages, at } = useComic()

    // A sheet of the reader's own, which only this browser knows about.
    pages.value[1]!.stack = [
      ...structuredClone(DEFAULT_STACK),
      { id: 'paint:a1b2c3d4', label: 'Sketch', visible: true, opacity: 80, paint: true },
    ]

    scope.run(() => useLayerSync())
    await settle()

    at.value = 1
    await settle()
    await outlast()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.pageId).toBe(2)
    expect(puts[0]!.layers.map((row) => row.uid)).toContain('paint:a1b2c3d4')
  })

  it('sends a claimed stack even when it is the default, and spends the claim', async () => {
    const { at } = useComic()

    useLayerClaims().value = ['page-b']

    scope.run(() => useLayerSync())
    await settle()

    at.value = 1
    await settle()
    await outlast()

    expect(puts.map((put) => put.pageId)).toEqual([2])
    expect(useLayerClaims().value).toEqual([])
  })
})
