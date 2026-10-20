/**
 * Whether the page engine draws with WebGPU — one answer for the tab.
 *
 * Two readers need it and must not disagree: the engine, which draws with it,
 * and the board, which asks `engineRun` which rows the engine draws — and on
 * 2D that is fewer, since a row an adjustment reaches keeps its SVG filter.
 *
 * `undefined` while the device is being asked for, `null` for 2D. Setting
 * `kemolate:scan-gpu` to `'0'` in this browser forces 2D, for measuring the
 * two against each other; nothing in the app writes it.
 */

import { shallowRef } from 'vue'

import { dropHeld } from '../held'

import { openGpu, setCloseOnUpload } from './gpu'
import { keepPictures } from './pictures'

import type { Gpu } from './gpu'

export const engineGpu = shallowRef<Gpu | null | undefined>(undefined)

/** A setting given by hand, for measuring: `'0'` turns off what is otherwise on. */
export function switchedOff (name: string): boolean {
  try {
    return import.meta.client && localStorage.getItem(`kemolate:${name}`) === '0'
  } catch {
    return false
  }
}

let started = false

/** Ask for the device, once. */
export function startEngine () {
  if (started || !import.meta.client) return

  started = true

  if (switchedOff('scan-gpu')) {
    setCloseOnUpload(false)
    engineGpu.value = null

    return
  }

  openGpu().then((gpu) => {
    if (!gpu) console.warn('[kemolate] WebGPU would not open; the page is drawn in 2D')

    // On the GPU a picture is its texture, and the bitmap is let go of once
    // uploaded; on 2D the bitmap is the picture. See `closeOnUpload`.
    setCloseOnUpload(!!gpu)
    engineGpu.value = gpu

    // A GPU reset or reclaimed takes the device and every texture with it —
    // and so every picture, since their bitmaps were closed on upload. Let
    // them all go and ask again; the engine asks for its pictures afresh when
    // the device changes.
    gpu?.device.lost.then(() => {
      dropHeld()
      keepPictures(new Set())
      engineGpu.value = undefined
      started = false
      startEngine()
    })
  })
}
