import { describe, expect, it } from 'vitest'

import { nearlyLevel } from '~/utils/ocr/paddle-rec'

/**
 * Whether a PP-OCR line quad is stored as a lean or as an upright box.
 *
 * The case that made this necessary: a chapter read with PP-OCR stored 31
 * lines at ±0.2–1.8°, every one of them upright on the page, because the
 * detector's `minAreaRect` fits a ragged blob and almost never lands exactly
 * level. Everything else that measures a lean snaps inside four degrees; this
 * quad was the one path that did not.
 */

/** A w×h rectangle about (cx, cy), turned `degrees` clockwise, corners from `start`. */
function quad (degrees: number, start = 0, w = 200, h = 40, cx = 300, cy = 300) {
  const r = (degrees * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const corners = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const)
    .map(([dx, dy]) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }))

  return [...corners.slice(start), ...corners.slice(0, start)]
}

describe('nearlyLevel', () => {
  it.each([0, 0.3, -0.9, 1.8, -4])('calls a %s° quad level', (degrees) => {
    expect(nearlyLevel(quad(degrees))).toBe(true)
  })

  it.each([4.5, -6, 12, -21.5, 30])('keeps a %s° quad as a lean', (degrees) => {
    expect(nearlyLevel(quad(degrees))).toBe(false)
  })

  it('judges the lean, not which corner the quad starts at', () => {
    // The same rectangle a quarter turn round its corner list reads 90° off
    // its top edge; folded, it is the same small lean.
    expect(nearlyLevel(quad(1.2, 1))).toBe(true)
    expect(nearlyLevel(quad(15, 1))).toBe(false)
  })
})
