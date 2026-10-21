import { describe, expect, it } from 'vitest'

import type { Drawn } from '#shared/utils/layers'
import type { Over } from '~/utils/raster/engine/overs'

import { underPlan } from '~/utils/paint/under'

/**
 * What the sampling tools read under a paint surface.
 *
 * Clone, heal and the picker read the page flattened, and that used to be the
 * scan and the surface itself — so on a cleaned page they read the printed
 * lettering under every repair. Now it is every row below the surface that is
 * showing, drawn as the page draws it; the repairs are under the retouching
 * that shares their plate; and what no surface can draw — the mask, the
 * lettering — is left out rather than guessed at.
 *
 * Seam: `underPlan`, the pure choice of rows; drawing it is the page engine's
 * own 2D path.
 */

const row = (key: string, z: number, extra: Partial<Drawn> = {}): Drawn => ({
  key,
  z,
  visible: true,
  opacity: 1,
  editable: true,
  kind: 'plate',
  plate: key as Drawn['plate'],
  layer: key,
  ...extra,
})

const PAGE = { width: 1000, height: 1500 }
const repair: Over = { url: 'blob:repair', sx: 10, sy: 20, sw: 30, sh: 40, block: 'b1' }
const name = (surface: string) => `scan:1.png|${surface}`
const urlFor = () => 'blob:placed'

/** The default stack, bottom first, with a sheet over the lettering. */
const pile: Drawn[] = [
  row('art', 0),
  row('placed', 1, { kind: 'image', plate: null, image: { hash: 'h', ext: 'png', name: 'raw.png', size: 1, width: 1000, height: 1500 } as Drawn['image'] }),
  row('clean', 2),
  row('mask', 3),
  row('sfx', 4),
  row('dialogue', 5),
  row('sheet-top', 6, { kind: 'paint', plate: null, layer: 'sheet-top' }),
]

describe('the page under a paint surface', () => {
  it('is, for the retouching, the scan, the pictures placed under it and its own plate\'s repairs', () => {
    expect(underPlan(pile, 'bg', PAGE, [repair], name, urlFor)).toEqual([
      { opacity: 1, parts: [{ from: 'scan' }] },
      { opacity: 1, parts: [{ from: 'url', over: { url: 'blob:placed', sx: 0, sy: 0, sw: 1000, sh: 1500 } }] },
      { opacity: 1, parts: [{ from: 'url', over: repair }] },
    ])
  })

  it('is, for a sheet over the lettering, everything a surface can draw below it — and not the mask or the words', () => {
    const plan = underPlan(pile, 'sheet-top', PAGE, [repair], name, urlFor)

    expect(plan?.map((layer) => layer.parts.map((part) => part.from === 'surface' ? part.surface : part.from))).toEqual([
      ['scan'],
      ['url'],
      ['url', 'scan:1.png|bg'],
    ])
  })

  it('leaves out a row that is hidden, and carries a row\'s opacity', () => {
    const faded = pile.map((drawn) => drawn.key === 'placed' ? { ...drawn, visible: false } : drawn.key === 'art' ? { ...drawn, opacity: 0.5 } : drawn)

    expect(underPlan(faded, 'bg', PAGE, [], name, urlFor)).toEqual([
      { opacity: 0.5, parts: [{ from: 'scan' }] },
    ])
  })

  it('is nothing to say for a surface that is not in the pile', () => {
    expect(underPlan(pile, 'gone', PAGE, [repair], name, urlFor)).toBeNull()
  })
})
