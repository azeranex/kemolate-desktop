import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { forgetAgreed, useBlockSync } from '~/composables/useBlockSync'
import { useComic } from '~/composables/useComic'
import { useOcr } from '~/composables/useOcr'

/**
 * Measure balloons on a cloud workspace: each room goes up once, in one request
 * for the page, and nothing goes after it.
 *
 * `measureOne` PATCHes a page's rooms itself, through the page's batch route — a chapter's worth of measuring
 * happens on pages nobody is looking at, and `useBlockSync` only watches the one
 * on screen — and then agrees each reply with `useBlockSync`, which watches the
 * room there. Without that agreement every room on the page on screen is sent
 * twice: once by the measuring, and again a settle later by the sync, finding a
 * block that differs from what it last sent.
 *
 * Seam: every request that reaches the stand-in server while the page is
 * measured and after. The detector, the sheet and the verdicts are stubbed:
 * which balloon gets which room is `rooms.ts`'s question, with tests of its own.
 * In a file of its own because the verdicts are stubbed by name, and that name
 * belongs to code still moving.
 */

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('detectWith', () => async () => [])
mockNuxtImport('readScanSheet', () => async () => ({ w: 500, h: 700 }))
mockNuxtImport('roomVerdicts', () => (_sheet: unknown, blocks: { cx: number, cy: number, w: number, h: number }[]) =>
  blocks.map(({ cx, cy, w, h }) => ({ reason: 'room', room: { cx, cy, w: w * 0.8, h: h * 0.8 } })))

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
  room: { cx: number, cy: number, w: number, h: number } | null
  source: string
  confidence: number
  hidden: boolean
}

const server = { rows: [] as Row[] }
const calls: string[] = []

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

registerEndpoint('/api/workspaces/ws/blocks', {
  method: 'GET',
  handler: () => ({ [PAGE]: server.rows }),
})

for (const id of [730, 731, 732]) {
  registerEndpoint(`/api/workspaces/ws/blocks/${id}`, {
    method: 'PATCH',
    handler: async (event) => {
      const patch = await readBody<Partial<Row>>(event)
      const row = server.rows.find((one) => one.id === id)

      calls.push(`PATCH ${id} ${Object.keys(patch).sort().join(',')}`)

      if (!row) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

      Object.assign(row, patch)

      return row
    },
  })
}

// The page's batch route, which both the measuring and `useBlockSync` use — so
// a second round from the sync would land here as well as it would on the
// single-block routes above, and the "nothing after" check sees either.
registerEndpoint(`/api/workspaces/ws/pages/${PAGE}/blocks`, {
  method: 'PATCH',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: (Partial<Row> & { id: number })[] }>(event)
    const named = blocks.map(({ id, ...patch }) => `${id}:${Object.keys(patch).sort().join(',')}`)

    calls.push(`BATCH ${named.join(' ')}`)

    const missing = blocks.filter(({ id }) => !server.rows.some((row) => row.id === id)).map(({ id }) => id)

    if (missing.length) throw createError({ statusCode: 404, statusMessage: 'No such block.', data: { missing } })

    return blocks.map(({ id, ...patch }) => Object.assign(server.rows.find((row) => row.id === id)!, patch))
  },
})

describe('measuring the balloons of a page on a cloud workspace', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    calls.length = 0
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
      room: null,
      source: `row ${position}`,
      confidence: 100,
      hidden: false,
    }))
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

  it('sends each room once, in one request, and nothing after', async () => {
    const ocr = scope.run(() => useOcr())!

    scope.run(() => useBlockSync())
    await ocr.restore()
    await nextTick()
    await wait(50)

    calls.length = 0

    const page = useComic().pages.value[0]!

    expect(await ocr.measureBalloons([page])).toBe(3)
    await nextTick()
    await wait(700)

    // One request for the page, each entry carrying its room and nothing else —
    // and no second round from the sync once the rooms are on the blocks it
    // watches.
    expect(calls).toEqual(['BATCH 730:room 731:room 732:room'])
    expect(page.blocks.every((block) => block.room)).toBe(true)
    expect(server.rows.every((row) => row.room)).toBe(true)
    expect(ocr.error.value).toBeNull()
  })
})
