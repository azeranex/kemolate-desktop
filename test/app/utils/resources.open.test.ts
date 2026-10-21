import { describe, expect, it } from 'vitest'

import { backgroundDecoders, hashLanes } from '~/utils/resources'

/**
 * How wide the two pools behind opening a chapter are: the background decoders
 * (previews, thumbnails, a model's input) and the files hashed at once.
 *
 * Both were one — the decoders because there was one thread, the hashing
 * because it was written that way — and a drop was the other extreme, every
 * file dropped hashed at once. Each thread or file in flight holds a whole scan
 * in memory, so the width is bounded by the machine: its cores, and what the
 * browser says about its memory, which Firefox and Safari never do.
 *
 * Seam: the two helpers, given the two facts rather than reading them.
 */

describe('backgroundDecoders', () => {
  it('takes a third of the cores, and stops at three', () => {
    expect(backgroundDecoders(10, 32)).toBe(3)
    expect(backgroundDecoders(64, 32)).toBe(3)
    expect(backgroundDecoders(8, 16)).toBe(2)
    expect(backgroundDecoders(6, 8)).toBe(2)
    expect(backgroundDecoders(4, 8)).toBe(1)
  })

  it('never goes below one, however small the machine', () => {
    expect(backgroundDecoders(2, 8)).toBe(1)
    expect(backgroundDecoders(0, 8)).toBe(1)
  })

  it('runs one at four gigabytes or less', () => {
    expect(backgroundDecoders(10, 4)).toBe(1)
    expect(backgroundDecoders(10, 2)).toBe(1)
  })

  it('takes two where the browser will not say how much memory there is', () => {
    expect(backgroundDecoders(10, undefined)).toBe(2)
    expect(backgroundDecoders(4, undefined)).toBe(1)
  })
})

describe('hashLanes', () => {
  it('takes half the cores, and stops at four', () => {
    expect(hashLanes(10, 32)).toBe(4)
    expect(hashLanes(64, 32)).toBe(4)
    expect(hashLanes(6, 8)).toBe(3)
    expect(hashLanes(2, 8)).toBe(1)
    expect(hashLanes(0, 8)).toBe(1)
  })

  it('holds two files at most on a machine with four gigabytes or less', () => {
    expect(hashLanes(10, 4)).toBe(2)
    expect(hashLanes(2, 4)).toBe(1)
  })

  it('takes the cores at their word where the browser will not say about memory', () => {
    expect(hashLanes(10, undefined)).toBe(4)
  })
})
