import { describe, expect, it } from 'vitest'

import type { PlacedImage, StackLayer } from '#shared/utils/layers'

import {
  DEFAULT_STACK,
  findLayer,
  imageLayers,
  inkedLayer,
  LAYER_PRESETS,
  layerInk,
  layerRemovable,
  newAdjustLayer,
  newImageLayer,
  paintLayers,
  paintOrder,
  plateAdjusts,
  PLATES,
  plateStates,
  standardUids,
} from '#shared/utils/layers'

/**
 * The stack: what a page is built out of, what a drag does to it, and what a
 * chapter-wide preset may touch.
 *
 * **Needs no harness.** Every function under test here is pure and exported
 * from `shared/utils/layers.ts` — `dropLayer`, `findLayer`, `locateLayer`,
 * `clipBase`, `inkedLayer`, `paintOrder`, `plateStates`, `standardUids` — so
 * all of it runs in the sub-second unit project.
 *
 * That is worth saying out loud because it is not obvious from the app: layer
 * selection, dragging and clipping *look* like reactive concerns living in
 * `useComic`, and the arithmetic underneath them was already lifted out. What
 * remains in the composable is a one-line assignment — `moveLayer` is
 * `dropLayer(layers.value, …)` and nothing else. So the tree behaviour belongs
 * here, and only the *selection state* around it needs the nuxt project.
 *
 * The preset half is the one with teeth. A stack belongs to a page; the single
 * thing that speaks for a whole chapter is a preset, and the whole reason that
 * is safe is that it may only set `visible`, `opacity` and `locked` on the
 * seven standard rows. It cannot insert, delete, reorder or re-parent, and it
 * must not touch the sheets, groups and adjustments a reader added to their own
 * page. `standardUids` is that allowlist, enforced again server-side — see
 * `test/unit/server/services/layers.test.ts`, which asserts the server refuses
 * to trust a request about it.
 */

describe('the standard stack', () => {
  it.todo('founds every page with the same seven rows')
  it.todo('gives the standard rows stable uids, which is what a preset names them by')
})

describe('paintOrder and plateStates', () => {
  it.todo('paints a group\'s children under the group\'s own opacity')
  it.todo('drops a hidden row and everything inside it')
  it.todo('reports a plate as locked when the row that draws it is')
  it.todo('answers the same for a stack that has never been touched as for the default')
})

describe('finding a row', () => {
  it.todo('finds a row nested inside a group')
  it.todo('answers nothing for an id no longer in the stack')
  it.todo('locates a row as the list it sits in and its index within it')
})

describe('dropLayer — the drag', () => {
  it.todo('puts a row before its target')
  it.todo('puts a row after its target')
  it.todo('puts a row inside a group')
  it.todo('takes a row out of the group it was in when it lands elsewhere')
  it.todo('refuses to drop a group inside itself')
  it.todo('refuses to drop a group inside its own descendant')
  it.todo('leaves the stack alone when the row and the target are the same')
  it.todo('leaves the stack alone when either id is not in it')
})

describe('clipping', () => {
  it.todo('clips to the first unclipped row beneath')
  it.todo('answers nothing for a row with nothing beneath it to clip to')
  it.todo('reads through a run of clipped rows to the base they share')
})

describe('inkedLayer — what a brush stroke lands on', () => {
  it.todo('answers the selected row when it takes paint')
  it.todo('answers the mask row when the mask is what is being drawn')
  it.todo('answers nothing when the selection is locked')
  it.todo('answers nothing when the selection is hidden')
})

describe('a preset may only dress the standard rows', () => {
  it('names only rows in the standard allowlist', () => {
    const allowed = standardUids()

    for (const preset of LAYER_PRESETS) {
      expect(Object.keys(preset.rows).filter((uid) => !allowed.has(uid)), preset.id).toEqual([])
    }
  })

  it('sets visibility, opacity and lock, and nothing else', () => {
    const settable = new Set(['visible', 'opacity', 'locked'])

    for (const preset of LAYER_PRESETS) {
      const said = Object.values(preset.rows).flatMap((row) => Object.keys(row))

      expect(said.filter((key) => !settable.has(key)), preset.id).toEqual([])
    }
  })

  /*
   * Inserting, deleting, reordering and re-parenting are what *applying* a
   * preset could do, not what one says. The server's half is pinned in
   * `test/unit/server/services/layers.test.ts`; the browser's is
   * `useLayerPresets.arrange`, which needs the nuxt project.
   */
  it.todo('inserts no row')
  it.todo('deletes no row')
  it.todo('reorders nothing')
  it.todo('re-parents nothing')

  it('covers all seven standard rows in every preset, so none is left as it was by accident', () => {
    expect(standardUids().size).toBe(7)

    for (const preset of LAYER_PRESETS) expect(new Set(Object.keys(preset.rows)), preset.id).toEqual(standardUids())
  })
})

describe('the four presets say different things', () => {
  it.todo('Read shows the reading and hides the repair')
  it.todo('Clean shows the artwork being repaired and hides the words')
  it.todo('Letter shows the words over the repair')
  it.todo('Final shows what a reader would see and locks what they should not touch')
})

/**
 * A picture somebody placed, which is the third kind of row a reader can make.
 *
 * The case it was built for is a clean raw: a group with a cleaner has the
 * lettering taken out by hand at the source resolution, so the honest thing for
 * the app to do is draw that and get out of the way — place the image, set the
 * cleaner to None, and nothing here computes a repair at all.
 *
 * What is worth pinning is the **discriminator**, and the reason is a bug that
 * did not happen. There were two kinds of drawn row for a long time, so "has no
 * plate" meant "is a sheet of paint", and `paintLayers` was written that way —
 * correct, and correct only because nothing else could draw. A placed image has
 * no plate either. Under the old test every one of them would have been handed
 * to the canvas as a surface to paint on, and the symptom would have been a
 * blank canvas over the picture rather than an error anybody could see.
 */

const placed = (): PlacedImage => ({
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ext: 'png',
  name: '006_clean.png',
  width: 1754,
  height: 2480,
})

/** The default stack with a picture at the bottom of Cleanup, where one lands. */
function withPlaced (): StackLayer[] {
  const stack = structuredClone(DEFAULT_STACK)
  const cleanup = findLayer(stack, 'cleanup')

  cleanup!.children!.push(newImageLayer(placed()))

  return stack
}

describe('a placed image is its own kind of row', () => {
  it('is drawn, and says which kind it is', () => {
    const row = paintOrder(withPlaced()).find((one) => one.kind === 'image')

    expect(row).toBeDefined()
    expect(row!.plate).toBeNull()
    expect(row!.image).toEqual(placed())
  })

  /** The regression the discriminator exists to prevent — see the note above. */
  it('is not handed to the canvas as a sheet to paint on', () => {
    expect(paintLayers(withPlaced())).toEqual([])
  })

  it('is what `imageLayers` answers with, and the only thing', () => {
    const found = imageLayers(withPlaced())

    expect(found).toHaveLength(1)
    expect(found[0]!.image).toEqual(placed())
  })

  /**
   * Where one lands, and it is not arbitrary: under the lettering, over the
   * artwork, and *under the repairs* — a clean with one balloon the cleaner
   * missed should still be repairable, and the repair has to land on top of the
   * clean rather than beneath it. See `addImageLayer`.
   */
  it('sits between the repair and the artwork, which is where a clean belongs', () => {
    expect(paintOrder(withPlaced()).map((row) => row.plate ?? row.kind))
      .toEqual(['art', 'image', 'clean', 'mask', 'sfx', 'dialogue'])
  })

  /**
   * Everything about the plates except their height in the pile, which does
   * move — a row that draws takes a slot, and that is the point of it.
   */
  it('leaves every plate as visible, as faded and as locked as it was', () => {
    const before = plateStates(DEFAULT_STACK)
    const after = plateStates(withPlaced())

    for (const plate of PLATES) {
      expect({ ...after[plate], z: 0 }).toEqual({ ...before[plate], z: 0 })
    }
  })

  it('takes no ink, because a picture is placed rather than marked', () => {
    expect(layerInk(newImageLayer(placed()))).toBeNull()
  })

  it('may be removed, being a row the reader made rather than one the page is', () => {
    expect(layerRemovable(newImageLayer(placed()))).toBe(true)
  })

  it('is adjusted by what sits above it, like anything else that draws', () => {
    const stack = withPlaced()
    const row = imageLayers(stack)[0]!

    stack.unshift(newAdjustLayer('tone'))

    expect(plateAdjusts(stack)[row.key]).toHaveLength(1)
  })

  it('is named after the file, without the extension nobody wants to read', () => {
    expect(newImageLayer(placed()).label).toBe('006_clean')
  })

  it('falls back to a name rather than an empty label for a file that is only a suffix', () => {
    expect(newImageLayer({ ...placed(), name: '.png' }).label).toBe('Image')
  })
})

/**
 * And the one preset that had to move to make room for it.
 *
 * Read means "the page as it was printed", which is what a reading gets checked
 * against. A placed clean sits inside the Cleanup group, and a preset may not
 * touch a row the reader added — `standardUids` is the allowlist and that is
 * deliberate — so the group's own eye is the only lever that reaches it.
 *
 * For the standard rows this changes nothing, and the second case is what says
 * so: `mask` and `clean` were already hidden in Read, so hiding their group
 * hides the same two pixels and no others.
 */
describe('the Read preset reaches what is filed under Cleanup', () => {
  const read = LAYER_PRESETS.find((preset) => preset.id === 'read')!

  it('hides the group, so a placed clean cannot cover the printed lettering', () => {
    expect(read.rows.cleanup!.visible).toBe(false)
  })

  it('changes nothing about the plates, which that group was already hiding', () => {
    expect(read.rows.mask!.visible).toBe(false)
    expect(read.rows.clean!.visible).toBe(false)
  })

  it('is the only stage that hides it — the other three are stages of cleanup', () => {
    const others = LAYER_PRESETS.filter((preset) => preset.id !== 'read')

    expect(others.map((preset) => preset.rows.cleanup!.visible)).toEqual([true, true, true])
  })
})

/**
 * The mask brush, under every stage.
 *
 * The report: "don't lock the mask layer". Every stage but Read locked it, and
 * a preset speaks for the whole chapter — so choosing Clean, the stage for
 * cleaning, shut the mask brush out of every page at once. The brush is how a
 * repair is corrected from wherever it is noticed, so no stage may close it.
 */
describe('no preset shuts the mask brush out', () => {
  /** The standard stack, dressed the way a preset dresses it. */
  const dressed = (rows: Record<string, { visible?: boolean, opacity?: number, locked?: boolean }>) => {
    const walk = (list: StackLayer[]): StackLayer[] => list.map((row) => ({
      ...row,
      ...rows[row.id],
      ...(row.children ? { children: walk(row.children) } : {}),
    }))

    // From a stack whose mask was locked by the presets before this, so the
    // preset has to open it rather than merely leave it alone.
    const shut = (list: StackLayer[]): StackLayer[] => list.map((row) => ({
      ...row,
      ...(row.id === 'mask' ? { locked: true } : {}),
      ...(row.children ? { children: shut(row.children) } : {}),
    }))

    return walk(shut(DEFAULT_STACK))
  }

  it.each(LAYER_PRESETS.map((preset) => [preset.id, preset] as const))('leaves the mask open under %s', (_id, preset) => {
    expect(inkedLayer(dressed(preset.rows), null, 'mask')).not.toBeNull()
  })
})
