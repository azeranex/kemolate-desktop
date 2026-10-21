import { describe, expect, it } from 'vitest'

import { detectorBackend, fullPrecision } from '~/utils/ocr/detector'

/**
 * Where each build of the comic detector runs.
 *
 * Every build used to go to WebGPU wherever the browser had one. The two int8
 * builds are dynamically quantised — their convolutions and matrix products
 * are integer operators WebGPU has no kernels for — so ORT split each graph
 * and shuttled activations to its CPU provider and back, node by node: `fast`
 * took a second a page on the GPU against 0.77 s on WebAssembly alone. `full`
 * is fp32 end to end and takes 162 ms on the GPU against 3.6 s without it.
 *
 * So what decides is the precision of the weights, not whether a GPU exists —
 * and the failure this guards is the old rule creeping back, which reads as a
 * slow page rather than an error.
 */

describe('detectorBackend', () => {
  it('runs the int8 builds on WebAssembly even where WebGPU is on offer', () => {
    expect(detectorBackend('fast', true)).toBe('wasm')
    expect(detectorBackend('accurate', true)).toBe('wasm')
  })

  it('runs the fp32 build on WebGPU where it is on offer', () => {
    expect(detectorBackend('full', true)).toBe('webgpu')
  })

  it('runs every build on WebAssembly where there is no WebGPU', () => {
    expect(detectorBackend('fast', false)).toBe('wasm')
    expect(detectorBackend('accurate', false)).toBe('wasm')
    expect(detectorBackend('full', false)).toBe('wasm')
  })
})

describe('fullPrecision', () => {
  it('runs the fp16 build where the GPU can run half precision', () => {
    expect(fullPrecision(true, true)).toBe('fp16')
  })

  it('keeps fp32 on a GPU without it, and on WebAssembly, which has no fp16 arithmetic to gain from', () => {
    expect(fullPrecision(true, false)).toBe('fp32')
    expect(fullPrecision(false, true)).toBe('fp32')
    expect(fullPrecision(false, false)).toBe('fp32')
  })
})
