import { describe, expect, it } from 'vitest'

import type { StackLayer } from '#shared/utils/layers'

import { DEFAULT_STACK, paintOrder, plateAdjusts } from '#shared/utils/layers'
import { engineRun } from '~/utils/raster/engine/run'

/**
 * Which rows the page engine draws, and which stay elements.
 *
 * The engine is one canvas at one height in a pile the lettering shares, so it
 * draws a run from the bottom — the scan, placed pictures, the Clean plate's
 * repairs — and stops at the first row it does not draw. These are the stacks
 * that decide where that is.
 *
 * Seam: `engineRun` over `paintOrder` of real stacks.
 */

const run = (stack: StackLayer[], shader = true) => engineRun(paintOrder(stack), plateAdjusts(stack), shader)

const keys = (stack: StackLayer[], shader = true) => run(stack, shader).rows.map((row) => row.key)

/** The default stack with rows spliced into the Cleanup group, bottom of it first. */
function withCleanup (...extra: StackLayer[]): StackLayer[] {
  const stack = structuredClone(DEFAULT_STACK)
  const cleanup = stack.find((row) => row.children?.some((child) => child.plate === 'clean'))!

  cleanup.children = [...cleanup.children!, ...extra.reverse()]

  return stack
}

const picture = (id: string): StackLayer => ({
  id,
  label: id,
  image: { hash: id, ext: 'png', name: `${id}.png`, width: 100, height: 100 },
  visible: true,
  opacity: 100,
  locked: false,
} as StackLayer)

const sheet = (id: string): StackLayer => ({ id, label: id, paint: true, visible: true, opacity: 100, locked: false } as StackLayer)

describe('the engine\'s run', () => {
  it('is the art and the repairs on the default stack', () => {
    expect(keys(DEFAULT_STACK)).toEqual(['art', 'clean'])
    expect(run(DEFAULT_STACK).z).toBe(paintOrder(DEFAULT_STACK)[0]!.z)
  })

  it('takes in a picture placed at the bottom of the Cleanup group', () => {
    expect(keys(withCleanup(picture('raw')))).toEqual(['art', 'raw', 'clean'])
  })

  it('takes in a sheet between the art and the repairs — a sheet is a surface it draws', () => {
    expect(keys(withCleanup(sheet('retouch')))).toEqual(['art', 'retouch', 'clean'])
  })

  it('stops at the lettering, leaving a picture over it to the page', () => {
    const stack = structuredClone(DEFAULT_STACK)

    // A picture dragged to the very top of the pile, over the lettering.
    stack.unshift(picture('logo'))

    expect(keys(stack)).toEqual(['art', 'clean'])
  })

  it('goes on past the mask while it is hidden, and stops at it while it shows', () => {
    const stack = structuredClone(DEFAULT_STACK)
    const cleanup = stack.find((row) => row.children?.some((child) => child.plate === 'clean'))!

    // A sheet at the top of Cleanup — above the mask, below the lettering.
    cleanup.children!.unshift(sheet('touch-up'))

    expect(keys(stack)).toEqual(['art', 'clean', 'touch-up'])

    cleanup.children!.find((child) => child.plate === 'mask')!.visible = true

    expect(keys(stack)).toEqual(['art', 'clean'])
  })

  it('goes on past lettering that is hidden', () => {
    const stack = structuredClone(DEFAULT_STACK)

    // A sheet over all the lettering.
    stack.unshift(sheet('overlay'))

    expect(keys(stack)).toEqual(['art', 'clean'])

    for (const row of stack.filter((one) => one.plate === 'sfx' || one.plate === 'dialogue')) row.visible = false

    expect(keys(stack)).toEqual(['art', 'clean', 'overlay'])
  })

  it('keeps a row an adjustment reaches only where there is a shader for it', () => {
    const stack = withCleanup()
    const cleanup = stack.find((row) => row.children?.some((child) => child.plate === 'clean'))!

    // Levels, clipped onto the Clean plate.
    cleanup.children!.splice(cleanup.children!.findIndex((child) => child.plate === 'clean'), 0, {
      id: 'levels',
      label: 'Levels',
      adjust: { type: 'levels', inBlack: 20, inWhite: 235, gamma: 1, outBlack: 0, outWhite: 255 },
      clipped: true,
      visible: true,
      opacity: 100,
      locked: false,
    } as StackLayer)

    expect(keys(stack, true)).toEqual(['art', 'clean'])
    expect(run(stack, true).rows[1]!.adjust).toHaveLength(1)
    // On 2D the repairs keep their SVG filter as an element.
    expect(keys(stack, false)).toEqual(['art'])
  })
})
