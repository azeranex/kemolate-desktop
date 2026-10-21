import { beforeEach, describe, expect, it } from 'vitest'

import { dropSurface, holdSurface, surfaceOf, surfacesChanged, takeDirty, touchSurface } from '~/utils/raster/engine/surfaces'

/**
 * What the page engine is told about a paint surface's changes.
 *
 * A surface is the page's full size and a brush changes a few hundred pixels
 * of it a frame; uploading all of it each frame is what this bookkeeping is
 * for. So a change is a rectangle, several changes before a draw are one
 * rectangle around them all, and taking it for a draw leaves nothing behind.
 *
 * Seam: the registry, with plain canvases.
 */

const canvas = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height })

describe('a paint surface handed to the engine', () => {
  const key = 'scan:1.png|bg'
  let surface = canvas(1000, 1500)

  beforeEach(() => {
    surface = canvas(1000, 1500)
    holdSurface(key, surface)
  })

  it('is new all over when handed over', () => {
    expect(takeDirty(key)).toEqual({ x: 0, y: 0, w: 1000, h: 1500 })
    expect(takeDirty(key)).toBeNull()
  })

  it('is changed only where painting says, and several changes are one rectangle', () => {
    takeDirty(key)
    touchSurface(key, 10, 20, 30, 40)
    touchSurface(key, 100, 5, 10, 10)

    expect(takeDirty(key)).toEqual({ x: 10, y: 5, w: 100, h: 55 })
  })

  it('keeps a change inside the surface', () => {
    takeDirty(key)
    touchSurface(key, -20, 1490, 50, 50)

    expect(takeDirty(key)).toEqual({ x: 0, y: 1490, w: 30, h: 10 })
  })

  it('tells the engine when it is sized down to nothing, so its texture can go', () => {
    takeDirty(key)
    surface.width = 0
    surface.height = 0

    const before = surfacesChanged.value

    touchSurface(key)

    expect(surfacesChanged.value).toBe(before + 1)
    expect(takeDirty(key)).toBeNull()
  })

  it('is let go of only by the canvas that holds it — a remount does not undo the next one', () => {
    const next = canvas(1000, 1500)

    holdSurface(key, next)
    dropSurface(key, surface)

    expect(surfaceOf(key)).toBe(next)

    dropSurface(key, next)

    expect(surfaceOf(key)).toBeUndefined()
  })
})
