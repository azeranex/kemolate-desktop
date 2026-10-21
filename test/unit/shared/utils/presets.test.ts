import { describe, expect, it } from 'vitest'

import type { StackLayer } from '#shared/utils/layers'

import { DEFAULT_STACK, findLayer, LAYER_PRESETS, newPaintLayer, standardUids } from '#shared/utils/layers'
import { arrangeStack, stageStack } from '#shared/utils/presets'

/**
 * A stage laid on a page's stack — the desktop's stand-in for the server's
 * `layers.preset`, which is what a local chapter's other pages are arranged by.
 *
 * What has to hold is the server's rule: the standard rows get the stage's
 * `visible`, `opacity` and `locked`, the scan keeps its lock, and nothing else
 * in the tree moves or changes — above all a row a reader added.
 */

const presetOf = (id: string) => LAYER_PRESETS.find((preset) => preset.id === id)!

/** Every row of a stack, flattened with where it sits, so a move shows up. */
function shape (rows: StackLayer[], parent = ''): string[] {
  return rows.flatMap((row, index) => [`${parent}/${index}:${row.id}`, ...shape(row.children ?? [], row.id)])
}

describe('arrangeStack', () => {
  it('sets every standard row the stage names', () => {
    for (const preset of LAYER_PRESETS) {
      const stack = arrangeStack(structuredClone(DEFAULT_STACK), preset)

      for (const [uid, wanted] of Object.entries(preset.rows)) {
        const row = findLayer(stack, uid)!

        expect(row.visible, `${preset.id}:${uid}`).toBe(wanted.visible)

        if (wanted.opacity !== undefined) expect(row.opacity).toBe(wanted.opacity)

        if (wanted.locked !== undefined && !row.fixed) expect(row.locked ?? false).toBe(wanted.locked)
      }
    }
  })

  it('arranges in place and hands the same stack back', () => {
    const stack = structuredClone(DEFAULT_STACK)

    expect(arrangeStack(stack, presetOf('clean'))).toBe(stack)
  })

  it('never opens the scan', () => {
    for (const preset of LAYER_PRESETS) {
      const stack = arrangeStack(structuredClone(DEFAULT_STACK), preset)

      expect(findLayer(stack, 'art')!.locked).toBe(true)
    }
  })

  it('leaves a row a reader added exactly as it was, wherever it sits', () => {
    const stack = structuredClone(DEFAULT_STACK)
    const sheet = { ...newPaintLayer('Sketch'), visible: false, opacity: 40, locked: true }
    const cleanup = findLayer(stack, 'cleanup')!

    cleanup.children = [sheet, ...(cleanup.children ?? [])]

    const before = structuredClone(sheet)
    const order = shape(stack)

    for (const preset of LAYER_PRESETS) arrangeStack(stack, preset)

    expect(findLayer(stack, sheet.id)).toEqual(before)
    expect(shape(stack)).toEqual(order)
  })

  it('touches nothing on a row outside the allowlist that happens to share a stage key', () => {
    // A preset is held to `standardUids` even if its own list were to grow a
    // name a reader's row could carry.
    const stray = { ...newPaintLayer('Mine'), id: 'mine', visible: true }
    const preset = { ...presetOf('read'), rows: { ...presetOf('read').rows, mine: { visible: false } } }

    expect(standardUids().has('mine')).toBe(false)

    arrangeStack([stray], preset)

    expect(stray.visible).toBe(true)
  })
})

describe('stageStack', () => {
  it('founds a page with no stack on a copy of the default, arranged', () => {
    const founding = structuredClone(DEFAULT_STACK)
    const staged = stageStack(undefined, presetOf('read'))

    expect(shape(staged)).toEqual(shape(DEFAULT_STACK))
    expect(staged).not.toBe(DEFAULT_STACK)
    expect(findLayer(staged, 'dialogue')!.visible).toBe(false)
    // The founding stack itself is never arranged.
    expect(DEFAULT_STACK).toEqual(founding)
  })

  it('gives every page of a chapter the same arrangement of its standard rows', () => {
    const plain = structuredClone(DEFAULT_STACK)
    const grown = structuredClone(DEFAULT_STACK)

    grown.unshift(newPaintLayer('Notes'))

    const pages = [plain, grown, undefined].map((stack) => stageStack(stack, presetOf('clean')))

    const standard = (stack: StackLayer[]) => [...standardUids()].map((uid) => {
      const row = findLayer(stack, uid)!

      return `${uid}:${row.visible}:${row.opacity}:${row.locked ?? false}`
    })

    expect(standard(pages[1]!)).toEqual(standard(pages[0]!))
    expect(standard(pages[2]!)).toEqual(standard(pages[0]!))
  })
})
