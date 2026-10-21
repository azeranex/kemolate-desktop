import { describe, expect, it } from 'vitest'

import type { PagePatch } from '~/composables/useClean'

import { patchStands, renamePatch, restoreKeys } from '~/composables/useClean'
import { patchKey } from '~/utils/ocr/patches'

/**
 * When a repair is still a repair, and the reported bug that decided it.
 *
 * A page was cleaned, translated, and then a balloon's box was stretched to fit
 * the English — and the Chinese came back *through* the new lettering on two
 * balloons. The rule at the time withdrew a patch as soon as the block's box
 * drifted more than a pixel from the one the patch was cut for, on the argument
 * that a moved block has honestly not been cleaned. It has: a patch is artwork
 * of a *rectangle of the page*, and once the lettering inside that rectangle is
 * painted out it stays painted out, whatever anybody does to a box afterwards.
 *
 * So the block is deliberately not an argument here, and that absence is the
 * whole fix. What a repair has to agree with is the page's pixels — see
 * `PagePatch.scan` — and nothing else. Anything that consults the block's
 * geometry again brings the bug back.
 *
 * Nothing fails loudly if this regresses. The repair simply stops being drawn,
 * on exactly the pages somebody has done the most work to, which is why it is
 * worth a test.
 */

const HASH = '9cc28a68a077a7e5f1c0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3'

/** A repair of one rectangle of one scan, as `show` files it. */
function patch (extra: Partial<PagePatch> = {}): PagePatch {
  return {
    url: 'blob:http://localhost/one',
    // The padded box, in percentages, which is where the canvas draws it.
    x: 73.888,
    y: 71.532,
    w: 20.752,
    h: 23.548,
    // And the block box it was cut for, in page pixels.
    from: { x: 677.7, y: 916.5, w: 121.9, h: 232.1 },
    scan: HASH,
    ...extra,
  }
}

/** A measured, identified page. */
const scanned = (extra: Partial<NonNullable<ComicPage['scan']>> = {}) => ({
  url: 'blob:http://localhost/page',
  file: new File([], '6.jpg'),
  width: 877,
  height: 1240,
  hash: HASH,
  ...extra,
})

describe('patchStands', () => {
  it('keeps a repair whose block has been resized', () => {
    // The report itself: the block was widened to hold its translation, and the
    // repair under it is still a repair of the rectangle it was cut from.
    expect(patchStands(patch(), scanned())).toBe(true)
  })

  it('keeps a repair whose block has been moved somewhere else entirely', () => {
    // Anchoring, not dragging. The patch is drawn at its own `x/y/w/h` — the
    // canvas never lays it out at the block's — so a block carried across the
    // page leaves its repair over the artwork it actually repaired.
    expect(patchStands(patch({ from: { x: 0, y: 0, w: 1, h: 1 } }), scanned())).toBe(true)
  })

  it('drops a repair of a different scan', () => {
    // The guard that replaces the box comparison rather than merely losing it.
    // Patches are held per page *id*, which is the page's path: open a second
    // chapter that also has a `6.jpg` and the new page would otherwise inherit
    // the old one's repairs, drawn over artwork nobody here has cleaned.
    expect(patchStands(patch(), scanned({ hash: `ff${HASH.slice(2)}` }))).toBe(false)
  })

  it('holds a repair back while the page is still being identified', () => {
    // A hash lands after the pages are on screen. Until it does there is no way
    // to tell this page from the one whose repairs are in hand, and showing
    // them on the guess is the failure above with better timing.
    expect(patchStands(patch(), scanned({ hash: null }))).toBe(false)
  })

  it('drops a repair on a page nothing has measured', () => {
    // Every box here is a share of a size. With no size there is nowhere to put
    // the image, and a patch laid out against nought is not a repair of
    // anything.
    expect(patchStands(patch(), scanned({ width: 0, height: 0 }))).toBe(false)
  })

  it('has nothing to say about a block nobody has cleaned', () => {
    expect(patchStands(undefined, scanned())).toBe(false)
    expect(patchStands(null, scanned())).toBe(false)
  })

  it('has nothing to say about a page with no scan behind it', () => {
    // A workspace somebody joined knows what pages there are without holding
    // any of them — see `ComicPage.scan`.
    expect(patchStands(patch(), undefined)).toBe(false)
  })
})

/**
 * A repair following its block from one name to the next.
 *
 * The report: a chapter opened with none of its cleaning drawn, and switching
 * cleaner and back put it all up. Blocks put back from this browser's cache are
 * `read:…` until `useBlockSync` saves them and renames them to `block:<row>` —
 * after `restore` has filed every repair under the old name. This covers the
 * rule only: the call that applies it lives in `useBlockSync.adopt`, and
 * nothing here would notice that call going missing.
 */
describe('renamePatch', () => {
  it('carries a repair to the name its block now has', () => {
    const held = patch()
    const map = renamePatch({ 'scan:6.jpg': { 'read:ab12:0': held } }, 'scan:6.jpg', 'read:ab12:0', 'block:41')

    expect(map['scan:6.jpg']).toEqual({ 'block:41': held })
  })

  it('keeps the repair already filed under the new name', () => {
    // Made for the block as it is now, so it is the newer of the two.
    const old = patch({ url: 'blob:http://localhost/old' })
    const current = patch({ url: 'blob:http://localhost/current' })
    const map = renamePatch(
      { 'scan:6.jpg': { 'read:ab12:0': old, 'block:41': current } },
      'scan:6.jpg',
      'read:ab12:0',
      'block:41',
    )

    expect(map['scan:6.jpg']).toEqual({ 'block:41': current })
  })

  it('leaves the map alone for a block nothing was cleaned for', () => {
    const map = { 'scan:6.jpg': { 'block:7': patch() } }

    expect(renamePatch(map, 'scan:6.jpg', 'read:ab12:0', 'block:41')).toBe(map)
  })
})

/**
 * Which repairs a chapter opening may put back.
 *
 * The report: a chapter cleaned by an auto run with AOT came back bare on every
 * reload once the reader had tried LaMa on one page. The repairs were on disk
 * and matched their blocks exactly; the lookup only ever asked for the chosen
 * cleaner's. The chosen cleaner orders the candidates and no longer filters them.
 */
describe('restoreKeys', () => {
  const base = { scan: HASH, region: { x: 217, y: 765, w: 182, h: 232 }, edits: [] }

  it('finds a repair made by a cleaner other than the chosen one', () => {
    // The chapter in the report: cleaned with AOT and the learned mask, LaMa chosen now.
    const made = patchKey({ ...base, model: 'aot', source: 'segmenter' })

    expect(restoreKeys(base, 'lama', 'segmenter')).toContain(made)
  })

  it('asks for what the current settings would make first', () => {
    const [first, second] = restoreKeys(base, 'lama', 'segmenter')

    expect(first).toBe(patchKey({ ...base, model: 'lama', source: 'segmenter' }))
    // Then the same model from the other mask, before any other model.
    expect(second).toBe(patchKey({ ...base, model: 'lama', source: 'threshold' }))
  })

  it('names every model and both masks, once each', () => {
    const keys = restoreKeys(base, 'aot', 'threshold')

    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(6)
  })
})
