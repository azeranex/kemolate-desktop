import { describe, expect, it } from 'vitest'

/**
 * What can be read back out of a patch key, and has to keep meaning it.
 *
 * `patchKey`, `patchScan` and `patchMade` are auto-imported, the way the app
 * reaches them.
 *
 * A key is a private name for a file on this browser's disk, and it would be
 * reasonable to change how it is spelt — except that two things read it back.
 * A project file narrows the store to one chapter by `patchScan(key)` against
 * `hash.slice(0, 16)` of each page, and `useClean.adoptOrphans` places a repair
 * nothing asks for any more by the box `patchMade` reads out of its name. If
 * either stopped agreeing with `patchKey` the failure would be silent: an
 * export carrying none of the cleaning, or a repair laid somewhere it was not
 * cut from.
 */
describe('patchScan', () => {
  const scan = 'ed2eb30a41ce6115867b9487bd6e01e1049714067077ec0aab086f482de3269a'
  const region = { x: 838, y: 209, w: 75, h: 175 }

  it('reads back the prefix a page hash is narrowed to', () => {
    const key = patchKey({ scan, region, model: 'aot' })

    expect(patchScan(key)).toBe(scan.slice(0, 16))
  })

  it('survives the parts of a key that vary', () => {
    // The corrections and the model both extend the key to the right, and a
    // box of any width pushes the rest along. None of them may reach the front.
    const edited = patchKey({
      scan,
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      model: 'lama',
      edits: [{ kind: 'add', size: 40, hardness: 0.5, points: [10, 10, 20, 20] }],
    })

    expect(patchScan(edited)).toBe(scan.slice(0, 16))
  })

  it('tells two scans apart', () => {
    const other = `ff${scan.slice(2)}`

    expect(patchScan(patchKey({ scan, region, model: 'aot' })))
      .not.toBe(patchScan(patchKey({ scan: other, region, model: 'aot' })))
  })

  it('still reads the scan back out of a key naming the learned mask', () => {
    expect(patchScan(patchKey({ scan, region, model: 'aot', source: 'segmenter' }))).toBe(scan.slice(0, 16))
  })
})

/**
 * The half of a patch key that decides whether a toggle appears to work.
 *
 * The threshold and the learned segmenter are both current answers to "where
 * is the lettering", and the switch between them flips back and forth — so
 * repairs made each way sit side by side in the same cache directory, for the
 * same block, with the same corrections. A key that did not name the source
 * would serve whichever was made first, from a cache behaving exactly as
 * designed, and the switch would do nothing visible at all. Bumping
 * `MASK_RECIPE` cannot stand in for this: a version only invalidates the past,
 * and neither of these two is the past.
 */
describe('patchKey, on which mask made the repair', () => {
  const scan = 'ed2eb30a41ce6115867b9487bd6e01e1049714067077ec0aab086f482de3269a'
  const region = { x: 838, y: 209, w: 75, h: 175 }

  it('tells the two masks apart', () => {
    expect(patchKey({ scan, region, model: 'migan', source: 'segmenter' }))
      .not.toBe(patchKey({ scan, region, model: 'migan', source: 'threshold' }))
  })

  it('spells the threshold exactly as it was spelt before there were two', () => {
    // Every patch already on a disk was made this way and must go on being
    // found, or turning the feature on re-cleans chapters that were finished.
    expect(patchKey({ scan, region, model: 'migan', source: 'threshold' }))
      .toBe(patchKey({ scan, region, model: 'migan' }))
  })

  it('keeps the corrections telling repairs apart under either mask', () => {
    const edits: MaskEdit[] = [{ kind: 'add', size: 40, hardness: 0.5, points: [10, 10, 20, 20] }]

    expect(patchKey({ scan, region, model: 'migan', source: 'segmenter', edits }))
      .not.toBe(patchKey({ scan, region, model: 'migan', source: 'segmenter' }))
  })
})

/**
 * Cached repairs, and the three ways a stale one gets served.
 *
 * A patch is derived — given the scan, the box, the mask and the model it can
 * always be made again — so it is cached rather than stored, and losing it
 * costs a second of inference rather than anybody's work. What it must never do
 * is come back under a key that no longer describes it.
 *
 * All three failures have happened or nearly happened this month: a mask recipe
 * that changed without the version moving, two masks coexisting under one key
 * once the segmenter became optional, and a block resized so the key names a
 * region the file was never cut from.
 */

/**
 * The one thing about a cached repair this browser can decide on its own.
 *
 * Every other sweep needs the whole library: both caches are content-addressed
 * across workspaces, so "not used by the open chapter" would have two workspaces
 * delete each other's files every time the reader switched between them. A
 * superseded recipe is different in kind — the cleaner only ever asks for
 * `MASK_RECIPE`, so a patch filed under any other number is unaskable by any
 * chapter, in any workspace, for ever. That is decidable from the name alone,
 * and these are the tests that keep it decidable.
 *
 * The prefix cases are the ones that would hurt quietly. The recipe went 6 → 10
 * today, so a check written as `includes('-m1')` or `endsWith('m10')` reads a
 * key under recipe 1 as current and one under 10 as stale — and either way the
 * damage is a deletion, not an error.
 */
describe('the recipe a patch was made under', () => {
  const scan = 'ed2eb30a41ce6115867b9487bd6e01e1049714067077ec0aab086f482de3269a'
  const region = { x: 838, y: 209, w: 75, h: 175 }

  /** A key spelt the way `patchKey` spells one, under a recipe of our choosing. */
  const at = (recipe: number, tail = '') => `${scan.slice(0, 16)}-838-209-75-175-aot-m${recipe}${tail}`

  it('reads the recipe back out of a key the app just wrote', () => {
    expect(patchRecipe(patchKey({ scan, region, model: 'aot' }))).toBe(MASK_RECIPE)
  })

  it('reads a whole number and not a prefix of one', () => {
    expect(patchRecipe(at(1))).toBe(1)
    expect(patchRecipe(at(10))).toBe(10)
    expect(patchRecipe(at(100))).toBe(100)
  })

  it('reads past the parts of a key that come after the recipe', () => {
    expect(patchRecipe(at(6, '-seg-e1n0kqz'))).toBe(6)
  })

  it('refuses a name that is not a patch key', () => {
    expect(patchRecipe('scratch')).toBe(null)
    expect(patchRecipe('')).toBe(null)
    expect(patchRecipe(scan.slice(0, 16))).toBe(null)
  })
})

describe('which cached repairs can never be asked for again', () => {
  const scan = 'ed2eb30a41ce6115867b9487bd6e01e1049714067077ec0aab086f482de3269a'
  const region = { x: 838, y: 209, w: 75, h: 175 }

  const at = (recipe: number, tail = '') => `${scan.slice(0, 16)}-838-209-75-175-aot-m${recipe}${tail}`

  it('keeps a repair made under the recipe the cleaner asks for', () => {
    expect(patchSuperseded(patchKey({ scan, region, model: 'aot' }))).toBe(false)
    expect(patchSuperseded(patchKey({ scan, region, model: 'migan', source: 'segmenter' }))).toBe(false)
  })

  it('drops a repair made under a recipe that has been left behind', () => {
    // 6 shipped this month and 10 replaced it. The number only ever goes up —
    // see the log above `MASK_RECIPE` — so this can never come back into use.
    expect(patchSuperseded(at(6))).toBe(true)
    expect(patchSuperseded(at(6, '-e1n0kqz'))).toBe(true)
  })

  it('does not read recipe 1 as recipe 10, or the other way about', () => {
    // Spelt against the current number rather than a literal one: it was
    // `at(1)` against `at(10)` until the recipe moved to 11 and made both of
    // them stale. Its first digit is a prefix of it and names another recipe.
    const prefix = Number(String(MASK_RECIPE).slice(0, -1) || '0')

    expect(patchSuperseded(at(prefix))).toBe(true)
    expect(patchSuperseded(at(MASK_RECIPE))).toBe(false)
    expect(patchSuperseded(at(Number(`${MASK_RECIPE}0`)))).toBe(true)
  })

  it('leaves alone a name it cannot read a recipe out of', () => {
    // Something else's file in the same directory, or a key spelt by a version
    // of this app that is not this one. Unreadable is not the same as
    // superseded, and deleting on it would be deleting on a guess.
    expect(patchSuperseded('scratch')).toBe(false)
    expect(patchSuperseded('')).toBe(false)
    expect(patchSuperseded(scan.slice(0, 16))).toBe(false)
  })
})

describe('what makes two repairs different pictures', () => {
  it.todo('names a different mask source differently, so a toggle cannot serve the other one')
  it.todo('names a different inpainter differently')
  it.todo('names a different mask recipe differently')
  it.todo('names a hand-corrected mask differently from an untouched one')
  it.todo('gives the same block under the same settings the same name twice')
  it.todo('treats a sub-pixel nudge of the box as the same repair')
})

describe('patchMade', () => {
  const scan = 'ed2eb30a41ce6115867b9487bd6e01e1049714067077ec0aab086f482de3269a'
  const region = { x: 1503, y: 1039, w: 373, h: 312 }

  it('reads back what `patchKey` wrote', () => {
    expect(patchMade(patchKey({ scan, region, model: 'lama', source: 'segmenter' }))).toEqual({
      scan: scan.slice(0, 16),
      region,
      model: 'lama',
      recipe: MASK_RECIPE,
      segmenter: true,
      edited: false,
    })
  })

  it('says a repair made with corrections was, since their box cannot be read back', () => {
    const edits = [{ kind: 'add' as const, points: [1, 2, 3, 4], size: 8, hardness: 1 }]

    expect(patchMade(patchKey({ scan, region, model: 'aot', edits }))).toMatchObject({ model: 'aot', segmenter: false, edited: true })
  })

  it('is nothing for a name this app does not write', () => {
    expect(patchMade('notes')).toBeNull()
    expect(patchMade(`${scan.slice(0, 16)}-1-2-3-lama-m13`)).toBeNull()
  })
})
