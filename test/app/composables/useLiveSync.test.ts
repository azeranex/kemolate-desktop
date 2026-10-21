import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { forgetAgreed, useBlockSync } from '~/composables/useBlockSync'
import { useComic } from '~/composables/useComic'
import { useLiveSync } from '~/composables/useLiveSync'
import { useOcr } from '~/composables/useOcr'

/**
 * Somebody else's edit arriving, and what this browser sends because of it.
 *
 * A re-read is the third way the server's rows reach a page, beside a chapter
 * opening (`useOcr.restore`) and a reading's reply (`useOcr.persist`), and all
 * three now go through one agreement — `agreeArrived`, and `arrived` under it.
 * Before that each did its own subset, and the reply did none. These pin the
 * re-read's half: an arrival is not an edit, a block in the reader's hand still
 * goes up, and a re-read does not undo what a refused reading closed.
 *
 * Seam: the notice as the socket hands it over (`onSwarmChange`, captured), and
 * every request the page's sync sends after it, answered by `registerEndpoint`
 * standing in for a server that keeps the page's rows. Real timers: a notice
 * waits 250 ms, a save 500 ms, and the tests wait both.
 */

const { hear } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return { hear: ref<((room: string, change: { scope: string, pageId?: number }) => void) | null>(null) }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('onSwarmChange', () => (listener: typeof hear.value) => {
  hear.value = listener

  return () => {}
})

// Neither is what a block notice is about, and both stand up far more than it
// needs: the cleaning answers a different notice, and the library is only asked
// to let go of a page somebody deleted.
mockNuxtImport('useClean', () => () => ({ refreshRepairs: async () => {} }))
mockNuxtImport('useLibrary', () => () => ({ discard: async () => {} }))

// The engines, for the one test that reads the page: three balloons, at once.
mockNuxtImport('detectWith', () => async () => [{ x: 100, y: 100, w: 100, h: 100, label: 'text_bubble', score: 1 }])
mockNuxtImport('readWithReader', () => async () => [0.3, 0.6, 0.9].map((cy, at) => ({ cx: 0.3, cy, w: 0.1, h: 0.1, angle: 0, text: `read ${at}`, confidence: 1 })))
mockNuxtImport('readScanSheet', () => async () => null)

const PAGE = 165

interface Row {
  id: number
  pageId: number
  parentId: null
  position: number
  kind: string
  cx: number
  cy: number
  w: number
  h: number
  angle: number
  source: string
  confidence: number
  hidden: boolean
}

const server = { rows: [] as Row[], next: 800, refuse: false }
const calls: string[] = []

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const row = (id: number, position: number, cy: number, source = `row ${id}`): Row => ({
  id,
  pageId: PAGE,
  parentId: null,
  position,
  kind: 'bubble',
  cx: 0.5,
  cy,
  w: 0.2,
  h: 0.1,
  angle: 0,
  source,
  confidence: 100,
  hidden: false,
})

registerEndpoint('/api/workspaces/ws/blocks', {
  method: 'GET',
  handler: () => (server.rows.length ? { [PAGE]: server.rows } : {}),
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'GET',
  handler: () => {
    calls.push('GET page')

    return server.rows
  },
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PUT',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: Row[] }>(event)

    calls.push(`PUT ${blocks.length}`)

    if (server.refuse) throw createError({ statusCode: 503, statusMessage: 'Down for a moment.' })

    server.rows = blocks.map((draft, position) => ({ ...draft, id: server.next++, pageId: PAGE, parentId: null, position }))

    return server.rows
  },
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'POST',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: Row[] }>(event)

    calls.push(`POST ${blocks.length}`)

    const made = blocks.map((draft, at) => ({ ...draft, id: server.next++, pageId: PAGE, parentId: null, position: server.rows.length + at }))

    server.rows = [...server.rows, ...made]

    return made
  },
})

// A page's patches, which is how `useBlockSync` sends them — recorded row by row
// under the name a single PATCH had, so `writes()` reads the same either way.
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PATCH',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: { id: number }[] }>(event)

    for (const { id } of blocks) calls.push(`PATCH ${id}`)

    return blocks
  },
})

for (const id of [730, 731, 732, 733, ...Array.from({ length: 20 }, (_, at) => 800 + at)]) {
  registerEndpoint(`/api/workspaces/ws/blocks/${id}`, {
    method: 'PATCH',
    handler: () => {
      calls.push(`PATCH ${id}`)

      return { ok: true }
    },
  })
  registerEndpoint(`/api/workspaces/ws/blocks/${id}`, {
    method: 'DELETE',
    handler: () => {
      calls.push(`DELETE ${id}`)

      if (!server.rows.some((one) => one.id === id)) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

      server.rows = server.rows.filter((one) => one.id !== id)

      return { ok: true }
    },
  })
}

/** What the page holds, by id. */
const onPage = () => useComic().pages.value[0]!.blocks.map((block) => block.id)

/** Only the requests that write, which is what an arrival must not cause. */
const writes = () => calls.filter((call) => /^(PATCH|POST|DELETE)/.test(call))

/** Somebody else changed the page's blocks — the notice, and the re-read it sets off. */
async function notice () {
  hear.value!('ws', { scope: 'blocks', pageId: PAGE })
  await wait(400)
  await nextTick()
}

describe('a page re-read because somebody else changed it', () => {
  let scope = effectScope()

  beforeEach(async () => {
    scope = effectScope()
    calls.length = 0
    server.rows = [row(730, 0, 0.3), row(731, 1, 0.6), row(732, 2, 0.9)]
    server.next = 800
    server.refuse = false
    forgetAgreed()

    const comic = useComic()

    comic.reset()
    useState('workspace-shared').value = {
      role: 'editor',
      workspace: { publicId: 'ws', name: 'Chapter' },
      pages: [{ id: PAGE, uid: '4c57697c-b3d3-4027-b416-62e49b00aef8', path: '2.png', name: '2.png', position: 0, hash: 'h2', width: 1000, height: 1400 }],
    }
    comic.pages.value = [{
      id: 'scan:2.png',
      uid: '4c57697c-b3d3-4027-b416-62e49b00aef8',
      name: '2.png',
      blocks: [],
      scan: { url: 'blob:x', file: new File([], '2.png'), width: 1000, height: 1400, hash: 'h2' },
    }] as unknown as ComicPage[]
    comic.go(0)

    // The workspace page as a chapter opens: the three that push and pull
    // mounted, and the page's rows restored.
    scope.run(() => {
      useBlockSync()
      useLiveSync()
    })
    await scope.run(() => useOcr())!.restore()
    await nextTick()
    await wait(50)

    calls.length = 0
  })

  afterEach(() => {
    scope.stop()
    useState('workspace-shared').value = null
    useState('ocr-error').value = null
  })

  it('puts the server\'s page on screen and sends nothing back', async () => {
    // A block moved and retyped, one deleted, one added — all by somebody else.
    server.rows = [row(730, 0, 0.3), row(731, 1, 0.5, 'retyped'), row(733, 2, 1.1)]

    await notice()
    await wait(700)

    expect(onPage()).toEqual(['block:730', 'block:731', 'block:733'])
    expect(useComic().pages.value[0]!.blocks[1]!.source).toBe('retyped')

    // Not a PATCH repeating what was read, and above all not a DELETE for the
    // row somebody else took away: it left because the server said so.
    expect(writes()).toEqual([])
  })

  it('still sends a block the reader is holding, once they have it', async () => {
    const comic = useComic()

    // Picked up and moved here, while the other person's version of the same
    // block is on its way in.
    comic.setSelection(['block:731'])
    comic.pages.value[0]!.blocks[1]!.x = 70
    server.rows = [row(730, 0, 0.3), row(731, 1, 0.6, 'theirs'), row(732, 2, 0.9)]

    await notice()
    await wait(700)

    // The hand on the mouse is the later writer — see `reconcile`.
    expect(writes()).toEqual(['PATCH 731'])
  })

  it('does not open a page to appending that a refused reading closed', async () => {
    // A reading the server would not take: on the page, row-less, and closed to
    // appending until the page is read again — see `rewriting`.
    server.refuse = true

    await scope.run(() => useOcr())!.readCurrent()
    await nextTick()

    expect(onPage().every((id) => id.startsWith('read:'))).toBe(true)

    // Somebody else touches the page. The re-read carries the unsaved reading
    // across beside the server's rows, and must not take their arrival as the
    // page being the server's again: appending would put both readings there.
    await notice()
    await wait(700)

    expect(writes()).toEqual([])
    expect(server.rows.map((one) => one.id)).toEqual([730, 731, 732])
  })
})
