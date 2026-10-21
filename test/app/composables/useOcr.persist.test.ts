import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { forgetAgreed, useBlockSync } from '~/composables/useBlockSync'
import { useComic } from '~/composables/useComic'
import { useOcr } from '~/composables/useOcr'

/**
 * A reading written to a cloud workspace, and what the sync does after it.
 *
 * The report: `useOcr.readOne` put a fresh reading on the page as `read:`
 * blocks with no rows, *then* PUT it, and put the reply's rows on the page when
 * it answered — without telling `useBlockSync` that those rows were what the
 * server had just written. So:
 *
 * - every reading was followed by a PATCH per block, repeating the PUT, and a
 *   re-read by a DELETE per row it had replaced (404s — the PUT had deleted
 *   them already), each raising a change notice for every peer;
 * - a PUT slower than the settle left `useBlockSync` looking at a page of
 *   row-less blocks. It asked the server whether the page had rows and got an
 *   answer that depended on whether the PUT had landed: "no", and it appended
 *   the reading a second time; "yes", and it remembered that for the session,
 *   so no block placed on the page by hand was ever saved again;
 * - a PUT that failed left the DELETEs going out anyway, against the only
 *   reading the server still had.
 *
 * Seam: every request the page's sync sends after a reading, answered by
 * `registerEndpoint` standing in for the server — which keeps the page's rows,
 * so "the page was doubled" and "the old reading was deleted" are things these
 * tests can see rather than infer. The engines are stubbed: what they read is
 * not the question. Real timers; the settle is 500 ms and the tests wait it.
 */

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

// The engines, answering at once with three balloons. The sheet is refused so
// the balloons are not measured, which is a different composable's business.
mockNuxtImport('detectWith', () => async () => READ.map(({ cx, cy, w, h }) => ({
  x: (cx - w / 2) * 1000,
  y: (cy - h / 2) * 1000,
  w: w * 1000,
  h: h * 1000,
  label: 'text_bubble',
  score: 1,
})))
mockNuxtImport('readWithReader', () => async () => READ)
mockNuxtImport('readScanSheet', () => async () => null)

const READ = [
  { cx: 0.8, cy: 0.2, w: 0.1, h: 0.2, angle: 0, text: 'いち', confidence: 0.9 },
  { cx: 0.5, cy: 0.5, w: 0.1, h: 0.2, angle: 0, text: 'に', confidence: 0.9 },
  { cx: 0.2, cy: 1.1, w: 0.1, h: 0.2, angle: 0, text: 'さん', confidence: 0.9 },
]

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

/**
 * The server, as far as a page's blocks go: what it holds, and every request
 * that reached it, in order.
 */
const server = { rows: [] as Row[], next: 800 }
const calls: string[] = []

/**
 * How the next reading's PUT behaves. `early` is when the server writes it —
 * on arrival, or only once the delay is up — because the two races differ on
 * exactly that: what a read of the page sees while the reply is still coming.
 */
const put = { delay: 0, early: true, fail: false }

/** How long a read of the page takes to answer — `mayAppend`'s question. */
const get = { delay: 0 }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function write (drafts: Omit<Row, 'id' | 'pageId' | 'parentId' | 'position'>[], from: number): Row[] {
  return drafts.map((draft, at) => ({ ...draft, id: server.next++, pageId: PAGE, parentId: null, position: from + at }))
}

registerEndpoint('/api/workspaces/ws/blocks', {
  method: 'GET',
  handler: () => {
    calls.push('GET chapter')

    return server.rows.length ? { [PAGE]: server.rows } : {}
  },
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'GET',
  handler: async () => {
    calls.push('GET page')

    await wait(get.delay)

    return server.rows
  },
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PUT',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: Row[] }>(event)

    calls.push(`PUT ${blocks.length}`)

    const replace = () => { server.rows = write(blocks, 0) }

    if (put.early && !put.fail) replace()

    await wait(put.delay)

    if (put.fail) throw createError({ statusCode: 503, statusMessage: 'Down for a moment.' })
    if (!put.early) replace()

    return server.rows
  },
})
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'POST',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: Row[] }>(event)

    calls.push(`POST ${blocks.length}`)

    const made = write(blocks, server.rows.length)

    server.rows = [...server.rows, ...made]

    return made
  },
})

// A page's patches, which is how the sync sends them. Refused whole over a row
// the server does not hold, as `blocks.updateOnPage` is, and recorded row by
// row under the name a single PATCH had — so `writes()` below sees a patch for
// a row whichever door it went through.
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PATCH',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: { id: number }[] }>(event)

    for (const { id } of blocks) calls.push(`PATCH ${id}`)

    const missing = blocks.map(({ id }) => id).filter((id) => !server.rows.some((one) => one.id === id))

    if (missing.length) throw createError({ statusCode: 404, statusMessage: 'Not blocks on that page.', data: { missing } })

    return blocks.map(({ id }) => server.rows.find((one) => one.id === id))
  },
})

// Every row id a test can reach: the three it starts with, and the ones the
// server hands out. Registered one by one because an endpoint is matched on its
// exact path.
for (const row of [730, 731, 732, ...Array.from({ length: 40 }, (_, at) => 800 + at)]) {
  registerEndpoint(`/api/workspaces/ws/blocks/${row}`, {
    method: 'PATCH',
    handler: () => {
      calls.push(`PATCH ${row}`)

      if (!server.rows.some((one) => one.id === row)) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

      return { ok: true }
    },
  })
  registerEndpoint(`/api/workspaces/ws/blocks/${row}`, {
    method: 'DELETE',
    handler: () => {
      calls.push(`DELETE ${row}`)

      if (!server.rows.some((one) => one.id === row)) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

      server.rows = server.rows.filter((one) => one.id !== row)

      return { ok: true }
    },
  })
}

/** The page's reading as the workspace already had it — three balloons, rows 730–732. */
function readBefore () {
  server.rows = [0.3, 0.6, 0.9].map((cy, position) => ({
    id: 730 + position,
    pageId: PAGE,
    parentId: null,
    position,
    kind: 'bubble',
    cx: 0.5,
    cy,
    w: 0.2,
    h: 0.1,
    angle: 0,
    source: `before ${position}`,
    confidence: 100,
    hidden: false,
  }))
}

/** What the page holds, by id. */
const onPage = () => useComic().pages.value[0]!.blocks.map((block) => block.id)

/** Only the requests that write, which is what an arrival must not cause. */
const writes = () => calls.filter((call) => /^(PATCH|POST|DELETE)/.test(call))

describe('a reading saved to a cloud workspace', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    calls.length = 0
    server.rows = []
    server.next = 800
    Object.assign(put, { delay: 0, early: true, fail: false })
    get.delay = 0
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
  })

  afterEach(() => {
    scope.stop()
    useState('workspace-shared').value = null
    useState('ocr-error').value = null
  })

  /** The workspace page as it stands once a chapter has opened: the sync mounted, the rows restored. */
  async function opened () {
    const ocr = scope.run(() => useOcr())!

    scope.run(() => useBlockSync())
    await ocr.restore()
    await nextTick()
    await wait(50)

    calls.length = 0

    return ocr
  }

  describe('an arrival is not an edit', () => {
    it('sends nothing for a page the chapter opened onto', async () => {
      readBefore()

      await opened()
      await wait(700)

      expect(onPage()).toEqual(['block:730', 'block:731', 'block:732'])
      expect(writes()).toEqual([])
    })

    it('sends nothing after a reading the server has answered for', async () => {
      readBefore()

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      // The PUT was the whole of it: no PATCH repeating each row it had just
      // written, and no DELETE for the rows it had just replaced.
      expect(calls).toEqual(['PUT 3'])
      expect(onPage()).toEqual(['block:800', 'block:801', 'block:802'])
    })
  })

  describe('a PUT slower than the settle', () => {
    it('appends nothing to a page read for the first time', async () => {
      // Written only once the delay is up, so a read of the page in the
      // meantime finds it empty — the answer that used to append the reading
      // a second time.
      Object.assign(put, { delay: 700, early: false })

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      expect(calls).toEqual(['PUT 3'])
      expect(server.rows.map((row) => row.source)).toEqual(['いち', 'に', 'さん'])
      expect(onPage()).toEqual(['block:800', 'block:801', 'block:802'])
    })

    it('deletes nothing it replaced, and still saves a block placed afterwards', async () => {
      // Written on arrival, so a read of the page in the meantime finds the new
      // rows — the answer that used to close the page to appending for good.
      Object.assign(put, { delay: 700, early: true })
      readBefore()

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      expect(writes()).toEqual([])

      // Placed with the Text tool, after the reading has landed.
      const comic = useComic()

      expect(comic.addBlock({ x: 10, y: 10, w: 10, h: 5 })).not.toBeNull()
      await nextTick()
      await wait(700)

      expect(writes()).toEqual(['POST 1'])
      expect(server.rows).toHaveLength(4)
      expect(onPage()).toEqual(['block:800', 'block:801', 'block:802', 'block:803'])
    })
  })

  describe('while the PUT is out', () => {
    it('gives no row to a block placed by hand, which goes with the page', async () => {
      // Written on arrival and answered a second later: long enough for a block
      // placed meanwhile to wait out its settle and be offered a row.
      Object.assign(put, { delay: 1000, early: true })
      readBefore()

      const ocr = await opened()
      const reading = ocr.readCurrent()

      await wait(100)
      expect(useComic().addBlock({ x: 10, y: 10, w: 10, h: 5 })).not.toBeNull()

      await reading
      await nextTick()
      await wait(700)

      // Appended after the PUT had written the page, it would have outlived the
      // reading on the server as a box nothing on this page names.
      expect(writes()).toEqual([])
      expect(server.rows.map((row) => row.source)).toEqual(['いち', 'に', 'さん'])
      expect(onPage()).toEqual(['block:800', 'block:801', 'block:802'])
    })

    it('sends nothing still waiting for a row the reading took', async () => {
      Object.assign(put, { delay: 300, early: true })
      readBefore()

      const ocr = await opened()
      const reading = ocr.readCurrent()

      // Deleted by the reader while the PUT is out: a DELETE for 731 waits out
      // its settle, and so does a PATCH for 732, whose place in the list moved
      // up. The reply lands inside that settle and replaces both rows — and a
      // row no longer on the page is never found again to call its timer off.
      await wait(100)
      useComic().removeBlock('block:731')

      await reading
      await nextTick()
      await wait(700)

      expect(writes()).toEqual([])
    })

    it('lets an answer about the page outrank a question asked before it', async () => {
      // A block placed on an empty page asks whether the page may be appended
      // to, and the answer is slow enough that a reading lands in between. The
      // server it describes is the one the reading wrote.
      get.delay = 600

      const ocr = await opened()
      const comic = useComic()

      comic.addBlock({ x: 10, y: 10, w: 10, h: 5 })
      await nextTick()
      await wait(550)

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      // The page is the server's rows and nothing else, so a block placed now is
      // new — and is saved, rather than refused on the strength of a "no" the
      // late answer would have written over the reading's "yes".
      expect(comic.addBlock({ x: 50, y: 50, w: 10, h: 5 })).not.toBeNull()
      await nextTick()
      await wait(1400)

      expect(onPage()).toHaveLength(4)
      expect(onPage().every((id) => id.startsWith('block:'))).toBe(true)
      expect(server.rows.map((row) => row.source)).toEqual(['いち', 'に', 'さん', ''])
    })
  })

  describe('a PUT that fails', () => {
    it('keeps the reading on the page and deletes nothing from the server', async () => {
      Object.assign(put, { fail: true })
      readBefore()

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      // The old reading is still the workspace's, untouched…
      expect(writes()).toEqual([])
      expect(server.rows.map((row) => row.id)).toEqual([730, 731, 732])

      // …and the new one is still on the page, saying it was not saved.
      expect(onPage().every((id) => id.startsWith('read:'))).toBe(true)
      expect(onPage()).toHaveLength(3)
      expect(ocr.error.value).toMatch(/not saved/)
    })

    it('does not append the unsaved reading to a page read for the first time', async () => {
      Object.assign(put, { fail: true })

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      expect(writes()).toEqual([])
      expect(server.rows).toEqual([])
    })

    it('saves the page again once it is read again', async () => {
      Object.assign(put, { fail: true })
      readBefore()

      const ocr = await opened()

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      Object.assign(put, { fail: false })

      await ocr.readCurrent()
      await nextTick()
      await wait(700)

      useComic().addBlock({ x: 10, y: 10, w: 10, h: 5 })
      await nextTick()
      await wait(700)

      expect(writes()).toEqual(['POST 1'])
      expect(server.rows.map((row) => row.source)).toEqual(['いち', 'に', 'さん', ''])
    })
  })
})
