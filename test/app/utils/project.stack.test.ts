import { describe, expect, it } from 'vitest'

import type { Adjustment } from '#shared/utils/adjust'
import type { PlacedImage, StackLayer } from '#shared/utils/layers'
import type { Project } from '~/utils/project'

import { PROJECT_VERSION, readManifest } from '~/utils/project'

/**
 * That a page's layer stack and its blocks survive the round trip **whole**.
 *
 * This exists because of how the format is validated rather than how it is
 * written. `projectSchema` is a `z.object`, and a `z.object` **strips keys it
 * has not been told about** — silently, with no error and nothing in the
 * console. So a field added to `StackLayer` or `Block` and not added to the
 * schema does not fail an import; it disappears from it. A reader's placed
 * clean, or the twirl on their group, is simply not there on the other side and
 * nothing anywhere says why.
 *
 * The `z.ZodType<StackLayer>` annotation on the schema does not catch it
 * either, which is the trap worth naming: that annotation only asks whether the
 * schema's *output* is assignable to `StackLayer`, and a shape missing an
 * optional field is perfectly assignable.
 *
 * So the guard is two halves that fail in two different ways:
 *
 * 1. The fixtures below are typed `{ [K in keyof Required<T>]: … }`, so adding
 *    a field to `StackLayer` or `Block` **stops this file compiling** until
 *    somebody puts a value for it here.
 * 2. The assertions are `toEqual` against the whole tree, so a schema that
 *    drops a field the fixture carries **fails at runtime**.
 *
 * Between them: a new field cannot reach the app without passing through here,
 * and a schema that forgets one cannot stay green.
 *
 * Seam: `readManifest`, against a maximal tree.
 */

const CLEAN: PlacedImage = {
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ext: 'png',
  name: '006_clean.png',
  width: 1754,
  height: 2480,
}

const LEVELS: Adjustment = {
  type: 'levels',
  inBlack: 12,
  inWhite: 240,
  gamma: 1.15,
  outBlack: 0,
  outWhite: 255,
}

/**
 * One row carrying **every** field a row can carry.
 *
 * The mapped type is the point: `keyof Required<StackLayer>` is every key,
 * optional ones included, so this object cannot omit one. It is nonsense as a
 * layer — a plate with children and an adjustment is not a thing anybody would
 * make — and that is fine. It is not a plausible stack, it is a complete one.
 */
const everyStackField: { [K in keyof Required<StackLayer>]: Required<StackLayer>[K] } = {
  id: 'image:a1b2c3d4',
  label: 'Clean raw',
  hint: 'The lettering taken out by hand',
  visible: true,
  opacity: 72,
  locked: true,
  fixed: true,
  plate: 'clean',
  paint: true,
  image: CLEAN,
  adjust: LEVELS,
  clipped: true,
  open: true,
  children: [],
}

const everyBlockField: { [K in keyof Required<Block>]: Required<Block>[K] } = {
  id: 'read:a1b2c3d4:0',
  type: 'sfx',
  x: 0.12,
  y: 0.34,
  w: 0.2,
  h: 0.11,
  angle: -12.5,
  skewX: 3,
  skewY: -2,
  quad: [1, 2, 3, 4, 5, 6, 7, 8],
  source: 'ゴゴゴ',
  translation: 'RUMBLE',
  confidence: 91,
  hidden: true,
  style: { size: 22, bold: true },
  letter: { x: 0.2, y: 0.3, w: 0.4, h: 0.2, angle: 4, skewX: 1, skewY: -1, quad: [8, 7, 6, 5, 4, 3, 2, 1] },
  room: { x: 0.05, y: 0.25, w: 0.5, h: 0.3 },
  children: [],
}

/**
 * A stack with shape as well as fields: two levels of nesting, a group whose
 * children are in a deliberate order, and the three kinds of row a reader can
 * make — a sheet, a placed image and an adjustment — beside the plates.
 */
const aStack = (): StackLayer[] => [
  { id: 'dialogue', label: 'Dialogue', visible: true, opacity: 100, plate: 'dialogue' },
  { id: 'my-notes', label: 'My notes', visible: true, opacity: 70, paint: true },
  { id: 'tone', label: 'Levels', visible: true, opacity: 100, adjust: LEVELS, clipped: true },
  {
    id: 'cleanup',
    label: 'Cleanup',
    hint: 'The repair that makes room for the lettering',
    visible: true,
    opacity: 100,
    open: true,
    children: [
      { id: 'image:c1', label: 'Clean raw', visible: true, opacity: 100, image: CLEAN },
      { id: 'mask', label: 'Mask', visible: false, opacity: 55, plate: 'mask' },
      { id: 'clean', label: 'Cleaned plate', visible: true, opacity: 100, plate: 'clean' },
    ],
  },
  {
    id: 'original',
    label: 'Original art',
    visible: true,
    opacity: 100,
    open: false,
    children: [
      { id: 'art', label: 'Image', visible: true, opacity: 100, plate: 'art', locked: true, fixed: true },
    ],
  },
]

const manifest = (pages: unknown[]) => JSON.stringify({
  v: PROJECT_VERSION,
  app: 'kemolate',
  exported: 1_754_700_000_000,
  title: 'Chapter 12',
  pages,
})

const through = (page: Record<string, unknown>) => {
  const held = readManifest(manifest([{ path: '006.jpg', name: '006', position: 0, blocks: [], ...page }]))

  if ('refused' in held) throw new Error(`the schema refused a valid page: ${held.refused}`)

  return (held as { project: Project }).project.pages[0]!
}

describe('a layer stack', () => {
  it('keeps every field a row can carry', () => {
    expect(through({ stack: [everyStackField] }).stack).toEqual([everyStackField])
  })

  it('keeps the order of the rows, top to bottom', () => {
    const stack = aStack()

    expect(through({ stack }).stack!.map((row) => row.id))
      .toEqual(['dialogue', 'my-notes', 'tone', 'cleanup', 'original'])
  })

  it('keeps the order of a group\'s children', () => {
    const held = through({ stack: aStack() }).stack!

    expect(held.find((row) => row.id === 'cleanup')!.children!.map((row) => row.id))
      .toEqual(['image:c1', 'mask', 'clean'])
  })

  it('keeps the whole tree, nesting and all', () => {
    const stack = aStack()

    expect(through({ stack }).stack).toEqual(stack)
  })

  it('keeps a placed image, which is the one row whose bytes cannot be remade', () => {
    const held = through({ stack: aStack() }).stack!
    const placed = held.find((row) => row.id === 'cleanup')!.children!.find((row) => row.id === 'image:c1')!

    expect(placed.image).toEqual(CLEAN)
  })

  it('keeps a paint sheet, which is a row with no plate and marks of its own', () => {
    const sheet = through({ stack: aStack() }).stack!.find((row) => row.id === 'my-notes')!

    expect(sheet.paint).toBe(true)
    expect(sheet.plate).toBeUndefined()
  })

  it('keeps an adjustment and its reach', () => {
    const tone = through({ stack: aStack() }).stack!.find((row) => row.id === 'tone')!

    expect(tone.adjust).toEqual(LEVELS)
    expect(tone.clipped).toBe(true)
  })

  it('keeps a row hidden, dimmed, locked and fixed rather than normalising it', () => {
    const held = through({ stack: aStack() }).stack!
    const mask = held.find((row) => row.id === 'cleanup')!.children!.find((row) => row.id === 'mask')!
    const art = held.find((row) => row.id === 'original')!.children![0]!

    expect(mask.visible).toBe(false)
    expect(mask.opacity).toBe(55)
    expect(art.locked).toBe(true)
    expect(art.fixed).toBe(true)
  })

  it('keeps a group shut, which `false` has to survive as itself', () => {
    const original = through({ stack: aStack() }).stack!.find((row) => row.id === 'original')!

    // Not `toBeFalsy`: a dropped key is falsy too, and dropping it is the bug.
    expect(original.open).toBe(false)
  })
})

describe('the blocks beside it', () => {
  it('keeps every field a block can carry', () => {
    expect(through({ blocks: [everyBlockField] }).blocks).toEqual([everyBlockField])
  })

  it('keeps a balloon, its members and their order', () => {
    const balloon = {
      ...everyBlockField,
      id: 'read:parent',
      children: [
        { ...everyBlockField, id: 'read:child-a', children: [] },
        { ...everyBlockField, id: 'read:child-b', children: [] },
      ],
    }

    expect(through({ blocks: [balloon] }).blocks[0]!.children!.map((child) => child.id))
      .toEqual(['read:child-a', 'read:child-b'])
  })

  it('keeps the order of the blocks on the page, which is the reading order', () => {
    const blocks = ['a', 'b', 'c', 'd'].map((id) => ({ ...everyBlockField, id: `read:${id}` }))

    expect(through({ blocks }).blocks.map((block) => block.id))
      .toEqual(['read:a', 'read:b', 'read:c', 'read:d'])
  })

  it('keeps a lettering frame, which is the only record of where the words go', () => {
    expect(through({ blocks: [everyBlockField] }).blocks[0]!.letter).toEqual(everyBlockField.letter)
  })

  it('keeps the lettering style as written, since absent means "as the app would"', () => {
    expect(through({ blocks: [everyBlockField] }).blocks[0]!.style).toEqual({ size: 22, bold: true })
  })
})
