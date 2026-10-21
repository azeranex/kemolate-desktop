import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { agreed, forgetAgreed, settled, useBlockSync } from '~/composables/useBlockSync'
import { useComic } from '~/composables/useComic'
import { toPatch } from '~/utils/ocr/blocks'

/**
 * A page's edits go up as one request, and what comes back is agreed.
 *
 * The report: every block that changed was a PATCH of its own — a settle after
 * sorting a page, or measuring its balloons, was a request per block, and a
 * chapter's worth of those was three to five hundred of them, each raising a
 * change notice of its own. The page's patches now go as one request to
 * `PATCH /pages/:id/blocks`, which the server writes in one transaction and
 * refuses whole.
 *
 * Refused whole is the part that needed care on this side. One PATCH per row
 * meant a row somebody else had deleted failed alone; in a batch it takes the
 * page with it. So the cases below include the two ways a page could be lost to
 * one row — a row the server no longer has, and a row it would refuse on sight
 * — and check that the rest of the page is saved regardless.
 *
 * Seam: every request that reaches the stand-in server, which keeps what it is
 * sent and refuses a batch the way `blocks.updateOnPage` does: all of it, with
 * the rows it could not find named in `data.missing`. Real timers; the settle
 * is 500 ms and the tests wait it.
 */

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

const PAGE = 165
const SCAN = { width: 1000, height: 1400 }

/** The rows the server holds, and what each was last sent. */
const server = { rows: new Map<number, Record<string, unknown>>() }

/** Every request that wrote, in order — a batch by the rows it named. */
const calls: string[] = []

registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PATCH',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: ({ id: number } & Record<string, unknown>)[] }>(event)

    calls.push(`page ${blocks.map((one) => one.id).join(',')}`)

    const missing = blocks.map((one) => one.id).filter((id) => !server.rows.has(id))

    if (missing.length) throw createError({ statusCode: 404, statusMessage: 'Not blocks on that page.', data: { missing } })

    for (const one of blocks) server.rows.set(one.id, one)

    return blocks
  },
})

// The one-block route, which the sync must no longer be reaching for.
for (const row of [730, 731, 732]) {
  registerEndpoint(`/api/workspaces/ws/blocks/${row}`, {
    method: 'PATCH',
    handler: () => {
      calls.push(`block ${row}`)

      return { id: row }
    },
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const block = (row: number, x: number) => ({
  id: `block:${row}`,
  type: 'bubble' as const,
  x,
  y: 10,
  w: 10,
  h: 10,
  source: `row ${row}`,
  translation: '',
  confidence: 100,
  hidden: false,
})

/** What the server was last sent for a row, as far as a move goes. */
const cxOf = (row: number) => server.rows.get(row)?.cx

describe('a page\'s edits', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    calls.length = 0
    server.rows = new Map([730, 731, 732].map((row) => [row, { id: row }]))
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
      blocks: [block(730, 10), block(731, 40), block(732, 70)],
      scan: { url: 'blob:x', file: new File([], '2.png'), width: 1000, height: 1400, hash: 'h2' },
    }] as unknown as ComicPage[]
    comic.go(0)

    // As the restore leaves a page it read from the server — see `arrived`.
    settled(comic.epoch.value, 'scan:2.png', [730, 731, 732])

    for (const [at, one] of comic.pages.value[0]!.blocks.entries()) {
      agreed(Number(one.id.slice('block:'.length)), toPatch(one, SCAN, at))
    }
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
    useState('workspace-shared').value = null
  })

  /** Move every block on the page a little, as one act — a nudge of the selection, say. */
  function moveAll (by: number) {
    const comic = useComic()

    comic.updateMany(comic.pages.value[0]!.blocks.map((one) => ({ id: one.id, patch: { x: one.x + by } })))
  }

  it('go up as one request for the page, not one per block', async () => {
    scope.run(() => useBlockSync())
    await wait(50)

    moveAll(5)
    await nextTick()
    await wait(700)

    expect(calls).toEqual(['page 730,731,732'])
    expect([cxOf(730), cxOf(731), cxOf(732)]).toEqual([0.2, 0.5, 0.8])
  })

  it('are agreed once the server has them, so nothing goes a second time', async () => {
    const comic = useComic()

    scope.run(() => useBlockSync())
    await wait(50)

    moveAll(5)
    await nextTick()
    await wait(700)

    // A pass over the page that changes nothing — a selection, which the sync
    // watches — finds every row already agreed.
    comic.selection.value = ['block:731']
    await nextTick()
    await wait(700)

    expect(calls).toEqual(['page 730,731,732'])

    // And a block moved afterwards goes up on its own, because the others are
    // agreed rather than merely sent.
    comic.selection.value = []
    comic.updateMany([{ id: 'block:732', patch: { x: 90 } }])
    await nextTick()
    await wait(700)

    expect(calls).toEqual(['page 730,731,732', 'page 732'])
  })

  it('are saved without a row somebody else deleted, rather than lost with it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scope.run(() => useBlockSync())
    await wait(50)

    // Deleted from under this tab, which has not heard yet.
    server.rows.delete(731)

    moveAll(5)
    await nextTick()
    await wait(700)

    // Refused whole over 731, then sent again without it — and 731 is not
    // offered to the server again on the next pass.
    expect(calls).toEqual(['page 730,731,732', 'page 730,732'])
    expect([cxOf(730), cxOf(732)]).toEqual([0.2, 0.8])
    expect(warn).toHaveBeenCalled()

    moveAll(5)
    await nextTick()
    await wait(700)

    expect(calls.slice(2).every((call) => !call.split(/[ ,]/).includes('731'))).toBe(true)
  })

  it('are saved without a block the server would refuse on sight', async () => {
    const comic = useComic()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scope.run(() => useBlockSync())
    await wait(50)

    // Longer than a row holds, which `blockPatchSchema` refuses — and in a
    // batch, refusing it would refuse the page.
    comic.updateMany([
      { id: 'block:730', patch: { x: 15 } },
      { id: 'block:731', patch: { source: 'あ'.repeat(4001) } },
      { id: 'block:732', patch: { x: 75 } },
    ])
    await nextTick()
    await wait(700)

    expect(calls).toEqual(['page 730,732'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('block 731 not saved'), expect.anything())
  })
})
