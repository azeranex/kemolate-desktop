import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { getQuery, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import type { StackLayer } from '#shared/utils/layers'

import { DEFAULT_STACK } from '#shared/utils/layers'
import CanvasPaint from '~/components/canvas/Paint.vue'
import { useComic } from '~/composables/useComic'
import { useLayerSync } from '~/composables/useLayerSync'
import { usePaintCache } from '~/composables/usePaintCache'
import { forgetPaintSync, usePaintSync } from '~/composables/usePaintSync'
import { useTools } from '~/composables/useTools'

/**
 * What painting and turning pages cost the server, counted where the requests
 * leave — and that nothing is lost for having been counted down.
 *
 * The report: every stroke was its own POST, and every POST sent each
 * collaborator back for the surface's whole log, twice. Turning to a page made
 * four requests before anything was drawn, two of them writes, and left a
 * founded stack and an empty surface behind on every page anybody looked at —
 * 162 of the 180 `bg` surfaces in the database had never held a mark.
 *
 * Seam: the canvas as the board mounts it, beside the layer sync the workspace
 * page mounts, against a server stood in for by `registerEndpoint` that speaks
 * both the old routes and the new ones — so these run, and fail, against the
 * code from before this change as well. Every request the pair makes is
 * recorded by the handler that answers it; that record is what is asserted.
 * Collaborators' notices go through `onSwarmChange`, captured. Real timers:
 * a batch waits up to 250 ms for company, a notice 120 ms, a retry a second.
 */

const WS = 'ws'

const { hear, shared, standing, scoped } = await vi.hoisted(async () => {
  const { computed, getCurrentScope, onScopeDispose, ref } = await import('vue')
  const shared = ref<unknown>(null)

  return {
    hear: [] as ((room: string, change: Record<string, unknown>) => void)[],
    shared,
    standing: computed(() => (shared.value ? 'ws:editor' : null)),
    // What the real `onSwarmChange` does with its unhooking: tied to the
    // caller's scope, so an unmounted canvas stops hearing.
    scoped: (off: () => void) => { if (getCurrentScope()) onScopeDispose(off) },
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('onSwarmChange', () => (listener: (room: string, change: Record<string, unknown>) => void) => {
  hear.push(listener)

  const off = () => {
    if (hear.includes(listener)) hear.splice(hear.indexOf(listener), 1)
  }

  scoped(off)

  return off
})
mockNuxtImport('useShared', () => () => ({
  shared,
  standing,
  pageRowOf: (page: { uid?: string }) => (shared.value ? ({ u1: 1, u2: 2 } as Record<string, number>)[page.uid ?? ''] ?? null : null),
}))

/* ---------- the server, old routes and new ---------- */

interface Row {
  id: number
  surfaceId: number
  seq: number
  clientId: string
  tool: string
  composite: string | null
  params: Record<string, unknown>
  points: number[]
  x: number
  y: number
  w: number
  h: number
  retracted: boolean
}

interface StoredLayer {
  id: number
  uid: string
  parentId: number | null
  position: number
  label: string
  hint: string | null
  plate: string | null
  visible: boolean
  opacity: number
  locked: boolean
  paint: boolean
  fixed: boolean
  clipped: boolean
  adjust: null
  image: null
}

const server = {
  layers: new Map<number, StoredLayer[]>(),
  surfaces: [] as { id: number, pageId: number, key: string }[],
  strokes: [] as Row[],
  next: 1000,
  /** Refuse this many stroke writes outright. */
  failing: 0,
  /** Land this many stroke writes, then lose the answer on the way back. */
  losing: 0,
}

/** Every request, as the handler that answered it saw it. */
const calls: { method: string, path: string, after?: number }[] = []

const record = (method: string, path: string, after?: number) => calls.push({ method, path, after })

function founded (pageId: number): StoredLayer[] {
  const out: StoredLayer[] = []
  const walk = (rows: StackLayer[], parentId: number | null) => rows.forEach((row, position) => {
    const id = ++server.next

    out.push({ id, uid: row.id, parentId, position, label: row.label, hint: row.hint ?? null, plate: row.plate ?? null, visible: row.visible, opacity: row.opacity, locked: row.locked ?? false, paint: false, fixed: row.fixed ?? false, clipped: false, adjust: null, image: null })
    walk(row.children ?? [], id)
  })

  walk(DEFAULT_STACK, null)
  server.layers.set(pageId, out)

  return out
}

function surfaceFor (pageId: number, key: string) {
  const held = server.surfaces.find((one) => one.pageId === pageId && one.key === key)

  if (held) return held

  const made = { id: 5000 + server.surfaces.length, pageId, key }

  server.surfaces.push(made)

  return made
}

/** A stroke landed, once — the `(surface, client, seq)` index, as the table has it. */
function lay (surfaceId: number, draft: Omit<Row, 'id' | 'surfaceId'>): { row: Row, fresh: boolean } {
  const held = server.strokes.find((row) => row.surfaceId === surfaceId && row.clientId === draft.clientId && row.seq === draft.seq)

  if (held) {
    held.retracted = draft.retracted ?? held.retracted

    return { row: held, fresh: false }
  }

  const row = { ...draft, retracted: draft.retracted ?? false, id: ++server.next, surfaceId }

  server.strokes.push(row)

  return { row, fresh: true }
}

/** Whether this write is refused, or lands and loses its answer. */
function trouble (): 'fail' | 'lose' | null {
  if (server.failing > 0) {
    server.failing--

    return 'fail'
  }

  if (server.losing > 0) {
    server.losing--

    return 'lose'
  }

  return null
}

const refuse = () => {
  throw Object.assign(new Error('The server is having a moment.'), { statusCode: 503 })
}

// The stack, both ways.
registerEndpoint(`/api/workspaces/${WS}/layers`, {
  method: 'GET',
  handler: (event) => {
    const pageId = Number(getQuery(event).pageId)

    record('GET', 'layers')

    return server.layers.get(pageId) ?? []
  },
})
registerEndpoint(`/api/workspaces/${WS}/layers`, {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ pageId: number }>(event)

    record('PUT', 'layers')

    return server.layers.get(body.pageId) ?? founded(body.pageId)
  },
})

// The old road: make the surface, read its log, a POST per stroke.
registerEndpoint(`/api/workspaces/${WS}/layers/ensure`, {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody<{ pageId: number, plate: string }>(event)

    record('POST', 'layers/ensure')

    const rows = server.layers.get(body.pageId) ?? founded(body.pageId)

    return rows.find((row) => row.plate === body.plate)
  },
})
registerEndpoint(`/api/workspaces/${WS}/surfaces`, {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody<{ pageId: number, key: string }>(event)

    record('POST', 'surfaces')

    return surfaceFor(body.pageId, body.key)
  },
})

for (let id = 5000; id < 5010; id++) {
  registerEndpoint(`/api/workspaces/${WS}/surfaces/${id}/strokes`, {
    method: 'GET',
    handler: () => {
      record('GET', 'surfaces/strokes')

      return server.strokes.filter((row) => row.surfaceId === id)
    },
  })
  registerEndpoint(`/api/workspaces/${WS}/surfaces/${id}/strokes`, {
    method: 'POST',
    handler: async (event) => {
      const body = await readBody<Omit<Row, 'id' | 'surfaceId'>>(event)

      record('POST', 'surfaces/strokes')

      const what = trouble()

      if (what === 'fail') refuse()

      const { row, fresh } = lay(id, body)

      if (what === 'lose') refuse()

      return fresh ? row : null
    },
  })
}

// The new road: a page's stack and paint in one read, and strokes in runs.
for (const pageId of [1, 2]) {
  registerEndpoint(`/api/workspaces/${WS}/pages/${pageId}/paint`, {
    method: 'GET',
    handler: (event) => {
      const query = getQuery(event)
      const after = Number(query.after ?? 0)

      record('GET', 'pages/paint', after)

      const surfaces = server.surfaces.filter((one) => one.pageId === pageId && !one.key.startsWith('mask-'))
      const rows = server.strokes.filter((row) => surfaces.some((one) => one.id === row.surfaceId))
      const horizon = rows.reduce((most, row) => Math.max(most, row.id), 0)

      return {
        ...(query.layers === '1' ? { layers: server.layers.get(pageId) ?? [] } : {}),
        horizon,
        surfaces: surfaces.map((one) => ({
          id: one.id,
          key: one.key,
          layerId: 1,
          strokes: rows.filter((row) => row.surfaceId === one.id && row.id > after),
          ...(after
            ? {
                retracted: rows.filter((row) => row.surfaceId === one.id && row.retracted).map((row) => row.id),
                total: rows.filter((row) => row.surfaceId === one.id).length,
              }
            : {}),
        })),
      }
    },
  })
}

registerEndpoint(`/api/workspaces/${WS}/strokes`, {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody<{ surfaces: { pageId: number, key: string, plate: string | null, layer: string | null, strokes: Omit<Row, 'id' | 'surfaceId'>[] }[] }>(event)

    record('POST', 'strokes')

    const what = trouble()

    if (what === 'fail') refuse()

    const answer = {
      surfaces: body.surfaces.map((group) => {
        // The plate's row, and the stack with it, made by the first stroke.
        if (group.plate && !server.layers.has(group.pageId)) founded(group.pageId)

        const surface = surfaceFor(group.pageId, group.key)
        const rows = group.strokes.map((draft) => lay(surface.id, draft).row)

        return { pageId: group.pageId, key: group.key, status: 'kept', surfaceId: surface.id, strokes: rows }
      }),
    }

    if (what === 'lose') refuse()

    return answer
  },
})

/* ---------- the page, the canvas and the hand ---------- */

const platform = { getContext: HTMLCanvasElement.prototype.getContext }

const page = (n: 1 | 2) => ({
  id: `scan:${n}.png`,
  uid: `u${n}`,
  name: `${n}.png`,
  blocks: [],
  stack: structuredClone(DEFAULT_STACK),
  scan: { url: `blob:${n}.png`, file: new File([], `${n}.png`), width: 3732, height: 5197, hash: `h${n}` },
})

let mounted: { unmount: () => void }[] = []
let scope = effectScope()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function settle (ms = 60) {
  await wait(ms)
  await flushPromises()
  await nextTick()
}

/** The workspace page's half — the stack sync — and one canvas, on page one. */
async function open () {
  const comic = useComic()

  scope.run(() => useLayerSync())

  const wrapper = await mountSuspended(CanvasPaint, { props: { page: comic.pages.value[0] as never, active: true } })

  mounted.push(wrapper)
  await settle(200)

  const hit = wrapper.find('div').element as HTMLElement

  hit.getBoundingClientRect = () => ({ left: 0, top: 0, width: 3732, height: 5197, right: 3732, bottom: 5197, x: 0, y: 0, toJSON: () => ({}) })

  /** One stroke, down to up, where `at` says. */
  const stroke = (at: number) => {
    const press = (type: string, x: number) => hit.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: 100 + at * 40, pointerId: 1 }))

    press('pointerdown', 200)
    press('pointermove', 400)
    press('pointerup', 400)
  }

  /** Turn to a page, the way the board does it: the page on screen, and the canvas on it. */
  const turn = async (n: 1 | 2) => {
    comic.at.value = n - 1
    await wrapper.setProps({ page: comic.pages.value[n - 1] as never })
  }

  return { wrapper, stroke, turn }
}

const writes = () => calls.filter((call) => call.method !== 'GET')
const strokeWrites = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('strokes'))
const local = (hash = 'h1') => usePaintCache().on(`${hash}:bg`)

describe('the paint canvas and the server', () => {
  beforeEach(() => {
    // happy-dom has no 2D context. Anything the session asks of one answers
    // with something that can be asked again — a gradient, a path, pixels.
    const anything: unknown = new Proxy(() => anything, {
      get: (_, name) => (name === 'data' ? new Uint8ClampedArray(4) : anything),
    })

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return new Proxy({}, { get: (_, name) => (name === 'canvas' ? this : () => anything) })
    } as unknown as typeof platform.getContext

    forgetPaintSync()
    usePaintCache().strokes.value = {}

    server.layers.clear()
    server.surfaces.length = 0
    server.strokes.length = 0
    server.failing = 0
    server.losing = 0
    calls.length = 0

    const comic = useComic()

    comic.reset()
    comic.pages.value = [page(1), page(2)] as never
    comic.at.value = 0

    useTools().tool.value = 'brush'
    shared.value = { role: 'editor', pages: [{ id: 1, uid: 'u1', path: '1.png', hash: 'h1' }, { id: 2, uid: 'u2', path: '2.png', hash: 'h2' }] }
    scope = effectScope()
  })

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()
    mounted = []
    scope.stop()
    shared.value = null
    useTools().tool.value = 'select'
    HTMLCanvasElement.prototype.getContext = platform.getContext
  })

  /*
   * Twenty strokes laid as fast as a script can lay them. One request carries
   * them — and every one of them lands, once, and leaves the local log.
   */
  it('sends a run of strokes in one request, and each lands once', async () => {
    const { stroke } = await open()

    for (let at = 0; at < 20; at++) stroke(at)

    await settle(800)

    expect(strokeWrites().length).toBeLessThanOrEqual(1)
    expect(server.strokes).toHaveLength(20)
    expect(new Set(server.strokes.map((row) => `${row.clientId}:${row.seq}`)).size).toBe(20)
    expect(local()).toHaveLength(0)
  })

  /*
   * A burst spread over time: the first stroke goes at once, and the rest wait
   * for company rather than going one a request.
   */
  it('gathers strokes laid while a batch is in the air', async () => {
    const { stroke } = await open()

    for (let at = 0; at < 12; at++) {
      stroke(at)
      await wait(20)
    }

    await settle(800)

    expect(server.strokes).toHaveLength(12)
    expect(strokeWrites().length).toBeLessThanOrEqual(3)
    expect(local()).toHaveLength(0)
  })

  /*
   * The request fails. Every stroke stays in this browser's log, and goes
   * again on its own — nobody has to paint another mark to get these saved.
   */
  it('keeps the strokes of a batch that failed, and sends them again', async () => {
    const { stroke } = await open()

    server.failing = 1

    stroke(0)
    stroke(1)
    stroke(2)
    await settle(300)

    expect(server.strokes).toHaveLength(0)
    expect(local()).toHaveLength(3)

    await settle(1500)

    expect(server.strokes).toHaveLength(3)
    expect(local()).toHaveLength(0)
  })

  /*
   * The batch landed and its answer did not. Sent again, the server knows
   * every stroke already — the index is a stroke's identity — and says so, so
   * the local copies are let go of with each mark on the server exactly once.
   */
  it('sends a batch whose answer was lost again, and each stroke lands once', async () => {
    const { stroke } = await open()

    server.losing = 1

    stroke(0)
    stroke(1)
    await settle(1800)

    expect(server.strokes).toHaveLength(2)
    expect(local()).toHaveLength(0)
  })

  /*
   * Looking at pages is not painting on them. Nothing is written — no stack
   * founded, no surface made — on arriving, turning away, or turning back.
   */
  it('makes no rows for a page that is only looked at', async () => {
    const { turn } = await open()

    await turn(2)
    await settle(200)
    await turn(1)
    await settle(900)

    expect(writes()).toEqual([])
    expect(server.surfaces).toEqual([])
    expect([...server.layers.keys()]).toEqual([])
  })

  /*
   * A page turn is one read: the stack and the paint on the page, together.
   */
  it('turns a page with one request', async () => {
    founded(1)
    founded(2)
    lay(surfaceFor(2, 'bg').id, { seq: 1, clientId: 'peer', tool: 'brush', composite: null, params: { size: 20 }, points: [10, 10, 40, 40], x: 0, y: 0, w: 50, h: 50, retracted: false })

    const { turn } = await open()

    calls.length = 0
    await turn(2)
    await settle(900)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')

    // And what it read is what the canvas draws.
    expect(usePaintSync().surfaceOf(2, 'bg')?.rows.map((row) => row.clientId)).toEqual(['peer'])
  })

  /*
   * Arriving: the chapter is open from this browser's storage before the
   * workspace's record lands, and when it does the page gains its row and the
   * workspace its standing in the same tick. Both used to ask for the page.
   */
  it('reads the page once when the workspace\'s record arrives', async () => {
    founded(1)

    const record = shared.value

    shared.value = null
    await open()

    calls.length = 0
    shared.value = record
    await settle(900)

    expect(calls).toEqual([{ method: 'GET', path: 'pages/paint', after: 0 }])
  })

  /*
   * A collaborator painting a run: a notice per batch, and the version bump
   * `useLiveSync` makes of each. Ten of them arriving together are one read —
   * and a read of what is new, not of the page's whole history again.
   */
  it('answers a burst of a collaborator\'s notices with one read of what is new', async () => {
    founded(1)

    const surface = surfaceFor(1, 'bg')

    lay(surface.id, { seq: 1, clientId: 'peer', tool: 'brush', composite: null, params: { size: 20 }, points: [10, 10, 40, 40], x: 0, y: 0, w: 50, h: 50, retracted: false })

    await open()

    // What the peer painted since the page was read.
    for (let seq = 2; seq <= 11; seq++) {
      lay(surface.id, { seq, clientId: 'peer', tool: 'brush', composite: null, params: { size: 20 }, points: [10, 10, 40, 40], x: 0, y: 0, w: 50, h: 50, retracted: false })
    }

    calls.length = 0

    for (let n = 0; n < 10; n++) {
      for (const listener of [...hear]) listener(WS, { scope: 'strokes', surfaceId: surface.id, pageId: 1, key: 'bg' })
    }

    await settle(600)

    const reads = calls.filter((call) => call.method === 'GET')

    expect(reads).toHaveLength(1)
    expect(reads[0]!.after).toBeGreaterThan(0)
    expect(usePaintSync().surfaceOf(1, 'bg')?.rows).toHaveLength(11)
  })
})
