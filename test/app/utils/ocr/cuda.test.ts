import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cudaChanged, cudaRead, cudaSession, cudaWanted, gaveUp } from '~/utils/ocr/cuda'

/**
 * The window's half of the CUDA process — desktop only.
 *
 * What is pinned here is what this side owns: tensors packed into one body with
 * a spec of each and unpacked into typed arrays of their own; the switch asked of
 * the main process every time, so turning it off is honoured on the next model;
 * and giving up once, said once, in the process's words rather than Electron's.
 * The process itself is exercised by driving the built app (see CLAUDE.md).
 *
 * Seam: `window.kemolate.cuda`, the preload's bridge, answered by hand.
 */

const toast = vi.hoisted(() => ({ warning: vi.fn() }))

vi.mock('~/utils/toast', () => ({ toast }))

const enabled = { value: true }

const bridge = {
  settings: vi.fn(async () => ({ enabled: enabled.value, python: 'python' })),
  open: vi.fn(async (model: string) => ({ path: `X:/models/${model}`, inputs: ['images'], outputs: ['scores'] })),
  run: vi.fn(async (_file: string, feeds: Record<string, { dtype: string, dims: number[], offset: number, length: number }>, body: Uint8Array) => {
    // Answer with what was sent, renamed — and a float32 of our own after it.
    const extra = new Float32Array([0.25, 0.5])
    const out = new Uint8Array(body.byteLength + extra.byteLength)

    out.set(body)
    out.set(new Uint8Array(extra.buffer), body.byteLength)

    return {
      outputs: {
        ...Object.fromEntries(Object.entries(feeds).map(([name, spec]) => [`${name}_back`, spec])),
        scores: { dtype: 'float32', dims: [2], offset: body.byteLength, length: extra.byteLength },
      },
      body: out,
    }
  }),
  read: vi.fn(async () => [[2, 10, 3]]),
}

beforeEach(() => {
  enabled.value = true
  cudaChanged()
  Object.assign(window, { kemolate: { cuda: bridge } })
})

afterEach(() => {
  vi.clearAllMocks()
  delete (window as { kemolate?: unknown }).kemolate
})

describe('cuda', () => {
  it('packs feeds into one body and unpacks each output into its own typed array', async () => {
    const session = await cudaSession('ogkalu/detector/resolve/main/detector.onnx')

    const images = { type: 'float32', dims: [1, 2], data: new Float32Array([1.5, -2]) }
    const sizes = { type: 'int64', dims: [1, 2], data: BigInt64Array.from([640n, 480n]) }

    const out = await session.run({ images, orig_target_sizes: sizes })

    expect(session.path).toBe('X:/models/ogkalu/detector/resolve/main/detector.onnx')
    expect(out.images_back!.data).toEqual(new Float32Array([1.5, -2]))
    expect(out.orig_target_sizes_back!.data).toEqual(BigInt64Array.from([640n, 480n]))
    expect(out.orig_target_sizes_back!.dims).toEqual([1, 2])
    expect(out.scores!.data).toEqual(new Float32Array([0.25, 0.5]))
  })

  it('hands a batch of crops over whole, with the decoding rules', async () => {
    const encoder = await cudaSession('k/enc.onnx')
    const decoder = await cudaSession('k/dec.onnx')
    const pixels = new Float32Array(6)

    const tokens = await cudaRead(encoder, decoder, pixels, 1, { edge: 224, start: 2, end: 3, limit: 300 })

    expect(tokens).toEqual([[2, 10, 3]])
    expect(bridge.read).toHaveBeenCalledWith(
      { encoder: 'X:/models/k/enc.onnx', decoder: 'X:/models/k/dec.onnx', count: 1, edge: 224, start: 2, end: 3, limit: 300 },
      expect.any(Uint8Array),
    )
  })

  it('asks for the switch every time, so turning it off is honoured at once', async () => {
    expect(await cudaWanted()).toBe(true)

    enabled.value = false

    expect(await cudaWanted()).toBe(false)
  })

  it('gives up once, says so once in the process’s own words, and is off until settings change', async () => {
    gaveUp('The text detector', new Error('Error invoking remote method \'cuda:open\': Error: That Python is not there: C:\\nowhere'))
    gaveUp('Kemolate OCR', new Error('again'))

    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning.mock.calls[0]![1].description).toMatch(/runs on WebGPU for the rest of this session\. That Python is not there/)
    expect(await cudaWanted()).toBe(false)

    cudaChanged()

    expect(await cudaWanted()).toBe(true)
  })

  it('is off outside the desktop app', async () => {
    delete (window as { kemolate?: unknown }).kemolate

    expect(await cudaWanted()).toBe(false)
  })
})
