import { describe, expect, it } from 'vitest'

import type { PagePatch } from '~/composables/useClean'

import { drawsRepair, repairOvers } from '~/utils/raster/engine/overs'

/**
 * Which repairs a page draws — desktop: not a garbage or hidden block's.
 *
 * Seam: `repairOvers`, which the page engine, the paint surfaces, the previews
 * and export all draw repairs through, with `stands` always yes so only the
 * block decides.
 */

const patch = (x: number): PagePatch => ({ url: `blob:${x}`, x, y: 10, w: 10, h: 10 }) as PagePatch

const page = (blocks: { id: string, type: 'bubble' | 'garbage', hidden?: boolean }[]) => ({
  id: 'p',
  name: 'p',
  blocks,
  scan: { url: '', file: new Blob(), width: 1000, height: 1500, hash: 'h' },
}) as unknown as ComicPage

const always = () => true

describe('repairOvers', () => {
  it('draws the repair of every block that is lettering', () => {
    const drawn = repairOvers(page([{ id: 'a', type: 'bubble' }, { id: 'b', type: 'bubble' }]), { a: patch(1), b: patch(2) }, always)

    expect(drawn.map((over) => over.block)).toEqual(['a', 'b'])
  })

  it('leaves out a garbage block\'s repair, and a hidden one\'s, though both are kept', () => {
    const held = { a: patch(1), b: patch(2), c: patch(3) }
    const drawn = repairOvers(page([
      { id: 'a', type: 'bubble' },
      { id: 'b', type: 'garbage' },
      { id: 'c', type: 'bubble', hidden: true },
    ]), held, always)

    expect(drawn.map((over) => over.block)).toEqual(['a'])
    // Kept: unmarking the block draws it again.
    expect(repairOvers(page([{ id: 'b', type: 'bubble' }]), held, always).map((over) => over.block)).toEqual(['b'])
  })
})

describe('drawsRepair', () => {
  it('is lettering that is not hidden', () => {
    expect(drawsRepair({ type: 'bubble', hidden: false })).toBe(true)
    expect(drawsRepair({ type: 'sfx', hidden: undefined as unknown as boolean })).toBe(true)
    expect(drawsRepair({ type: 'garbage', hidden: false })).toBe(false)
    expect(drawsRepair({ type: 'caption', hidden: true })).toBe(false)
  })
})
