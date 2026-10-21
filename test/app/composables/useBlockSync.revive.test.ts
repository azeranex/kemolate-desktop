import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { agreed, forgetAgreed, settled, useBlockSync } from '~/composables/useBlockSync'
import { useComic } from '~/composables/useComic'
import { useUndo } from '~/composables/useUndo'
import { toPatch } from '~/utils/ocr/blocks'

/**
 * A block taken back after its row was deleted is made a row again.
 *
 * The report: on a cloud workspace, a balloon deleted and then brought back by
 * Cmd+Z more than half a second later — past the settle, so its DELETE had gone
 * — came back on the page still carrying the dead row's id. Every move of it
 * was a 404, and the translations endpoint refuses a whole page over one block
 * it cannot find, so every translation edit on that page after that was lost.
 * Nothing on screen said so.
 *
 * Seam: what `useBlockSync` sends as the page changes, answered by
 * `registerEndpoint`. Real timers: the settle is 500 ms and the tests wait it.
 */

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

const calls: string[] = []
let nextRow = 900

registerEndpoint('/api/workspaces/ws/blocks/730', {
  method: 'DELETE',
  handler: () => { calls.push('DELETE 730'); return { ok: true } },
})
for (const row of [730, 731, 900, 901]) {
  registerEndpoint(`/api/workspaces/ws/blocks/${row}`, {
    method: 'PATCH',
    handler: () => { calls.push(`PATCH ${row}`); return { ok: true } },
  })
}
// A page's patches, which is how the sync sends them now — recorded row by row
// under the name a single PATCH had, so what is said below about a row holds
// whichever door it went through.
registerEndpoint('/api/workspaces/ws/pages/165/blocks', {
  method: 'PATCH',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: { id: number }[] }>(event)

    for (const { id } of blocks) calls.push(`PATCH ${id}`)

    return blocks
  },
})
registerEndpoint('/api/workspaces/ws/pages/165/blocks', {
  method: 'POST',
  handler: async (event) => {
    const { blocks } = await readBody<{ blocks: unknown[] }>(event)

    calls.push(`POST ${blocks.length}`)

    return blocks.map((_, position) => ({ id: nextRow++, pageId: 165, parentId: null, kind: 'bubble', cx: 0.2, cy: 0.2, w: 0.1, h: 0.1, angle: null, skewX: null, skewY: null, quad: null, source: 'x', confidence: 100, hidden: false, position }))
  },
})

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

describe('undo past the settle', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    calls.length = 0
    forgetAgreed()

    const comic = useComic()

    comic.reset()
    useState('workspace-shared').value = {
      role: 'editor',
      workspace: { publicId: 'ws', name: 'Chapter' },
      pages: [{ id: 165, uid: '4c57697c-b3d3-4027-b416-62e49b00aef8', path: '2.png', name: '2.png', position: 0, hash: 'h2', width: 1000, height: 1400 }],
    }
    comic.pages.value = [{
      id: 'scan:2.png',
      uid: '4c57697c-b3d3-4027-b416-62e49b00aef8',
      name: '2.png',
      blocks: [block(730, 10), block(731, 40)],
      scan: { url: 'blob:x', file: new File([], '2.png'), width: 1000, height: 1400, hash: 'h2' },
    }] as unknown as ComicPage[]
    comic.go(0)

    // As the restore leaves a page it read from the server: its rows noted, and
    // each block agreed to as it arrived — see `settled` and `agreeArrived`.
    settled(comic.epoch.value, 'scan:2.png', [730, 731])

    for (const [at, one] of comic.pages.value[0]!.blocks.entries()) {
      agreed(Number(one.id.slice('block:'.length)), toPatch(one, { width: 1000, height: 1400 }, at))
    }
  })

  afterEach(() => {
    scope.stop()
    useState('workspace-shared').value = null
  })

  it('makes the block a new row rather than patching the one that was deleted', async () => {
    const comic = useComic()

    scope.run(() => useBlockSync())
    await wait(50)

    comic.removeBlock('block:730')
    await nextTick()
    await wait(700)

    expect(calls).toContain('DELETE 730')

    await useUndo().undo()
    await nextTick()
    await wait(700)

    const back = comic.pages.value[0]!.blocks.find((one) => one.source === 'row 730')

    expect(calls).not.toContain('PATCH 730')
    expect(calls).toContain('POST 1')
    expect(back?.id).toMatch(/^block:9\d\d$/)
  })

  /**
   * Undo inside the settle is the other half: the deletion must never go at
   * all. It was called off only when the block came back *changed* — one put
   * back exactly as it was matched what the server had, was skipped over, and
   * its DELETE went out anyway.
   */
  it('sends no DELETE for a block put back within the settle', async () => {
    const comic = useComic()

    scope.run(() => useBlockSync())
    await wait(50)

    comic.removeBlock('block:730')
    await nextTick()
    await wait(100)

    await useUndo().undo()
    await nextTick()
    await wait(700)

    expect(calls).not.toContain('DELETE 730')
    expect(comic.pages.value[0]!.blocks.some((one) => one.id === 'block:730')).toBe(true)
  })
})
