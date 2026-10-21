import { describe, expect, it } from 'vitest'

import type { Backend } from '~/utils/resources'

import { BATCH, batchSize } from '~/utils/resources'

/**
 * How many crops one inference run may carry, by backend and by memory.
 *
 * The numbers are measured decisions rather than tunables — eight on WebGPU is
 * where manga-ocr's encoder stopped getting cheaper per crop and started
 * getting dearer, two on single-threaded WebAssembly takes all of the little
 * batching buys there — so they are pinned here, and a change to them should
 * arrive with new measurements, not as a drive-by. What is worth guarding
 * beyond the numbers is the halving: a batch sized for a desktop on a machine
 * that reports four gigabytes, and a batch of nought where a batch of one is
 * halved.
 */

describe('batchSize', () => {
  it('batches eight on WebGPU and two on WebAssembly where memory is plentiful', () => {
    expect(batchSize('webgpu', 16)).toBe(8)
    expect(batchSize('wasm', 16)).toBe(2)
  })

  it('takes a browser that does not say how much memory it has at its best', () => {
    expect(batchSize('webgpu', undefined)).toBe(8)
    expect(batchSize('wasm', undefined)).toBe(2)
  })

  it('halves the batch on a machine reporting four gigabytes or less', () => {
    expect(batchSize('webgpu', 8)).toBe(8)
    expect(batchSize('webgpu', 4)).toBe(4)
    expect(batchSize('webgpu', 2)).toBe(4)
    expect(batchSize('wasm', 4)).toBe(1)
  })

  it('never answers less than one, even halving a batch of one', () => {
    // A batch of nought is a reading loop that never advances — `readPieces`
    // steps through a page by the batch — so the floor is pinned against the
    // day somebody measures a backend down to one.
    const sizes = BATCH as Record<Backend, number>
    const held = sizes.wasm

    try {
      sizes.wasm = 1

      expect(batchSize('wasm', 0.25)).toBe(1)
    } finally {
      sizes.wasm = held
    }
  })
})
