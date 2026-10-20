import { describe, expect, it } from 'vitest'

import type { RepairRow } from '#shared/utils/repairs'

import { isPng, parseRect, REPAIR_KEY, repairFor } from '#shared/utils/repairs'

/**
 * The rules a stored repair is kept and found by.
 *
 * `repairFor` is the one with a report behind it: blocks moved or resized after
 * cleaning came back with no cleaning, because a repair was only ever found by
 * a name built from the block's box as it now stands. The server's record says
 * which block a repair belongs to, and the fallback to it is what these pin.
 */

function row (extra: Partial<RepairRow> = {}): RepairRow {
  return {
    key: '646bb2e490df4f96-388-195-203-310-lama-m10-seg',
    hash: 'a'.repeat(64),
    pageId: 129,
    blockId: 545,
    from: { x: 388, y: 195, w: 203, h: 310 },
    box: { x: 370, y: 180, w: 240, h: 340 },
    createdAt: 100,
    ...extra,
  }
}

describe('REPAIR_KEY', () => {
  it('accepts the keys patchKey writes', () => {
    expect(REPAIR_KEY.test('646bb2e490df4f96-388-195-203-310-lama-m10-seg')).toBe(true)
    expect(REPAIR_KEY.test('16be6a74d1b9c56b-868-2415-267-320-aot-m10')).toBe(true)
    expect(REPAIR_KEY.test('16be6a74d1b9c56b-868-2415-267-320-migan-m10-seg-e1k2z9')).toBe(true)
  })

  it('refuses anything that could be a path', () => {
    expect(REPAIR_KEY.test('../../kemolate.db')).toBe(false)
    expect(REPAIR_KEY.test('646bb2e490df4f96-388-195-203-310-lama-m10/../x')).toBe(false)
  })
})

describe('isPng', () => {
  it('knows a PNG by its signature and nothing else', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]))).toBe(true)
    expect(isPng(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0]))).toBe(false)
  })
})

describe('parseRect', () => {
  it('reads four numbers', () => {
    expect(parseRect('1,2.5,30,40')).toEqual({ x: 1, y: 2.5, w: 30, h: 40 })
  })

  it('refuses a rectangle with no area or a missing number', () => {
    expect(parseRect('1,2,0,40')).toBeNull()
    expect(parseRect('1,2,30')).toBeNull()
    expect(parseRect('a,b,c,d')).toBeNull()
  })
})

describe('repairFor', () => {
  it('finds a repair by recipe, in the order asked', () => {
    const lama = row()
    const aot = row({ key: lama.key.replace('lama', 'aot'), hash: 'b'.repeat(64) })

    expect(repairFor([aot, lama], [lama.key, aot.key], 545)).toBe(lama)
  })

  it('falls back to the newest repair made for the block when no recipe matches', () => {
    // The report: the block was moved after cleaning, so every name built from
    // its current box is a name nobody made.
    const older = row({ createdAt: 100 })
    const newer = row({ key: older.key.replace('388-195', '388-205'), hash: 'c'.repeat(64), createdAt: 200 })

    expect(repairFor([older, newer], ['646bb2e490df4f96-388-385-203-310-lama-m10-seg'], 545)).toBe(newer)
  })

  it('does not hand one block another block\'s repair', () => {
    expect(repairFor([row({ blockId: 546 })], [], 545)).toBeNull()
  })

  it('finds nothing by block for a block with no row', () => {
    expect(repairFor([row()], [], null)).toBeNull()
  })
})
