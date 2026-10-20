/**
 * What an adjustment layer does to the pixels under it.
 *
 * Non-destructive throughout: an adjustment is a small record of numbers, and
 * everything it does is derived from them on the way to the screen. The scan
 * is never touched — turn the row's eye off and the original colours are
 * simply there again, the same bargain the cleaned plate makes.
 *
 * ## One representation, two renderers
 *
 * Every adjustment here compiles to a per-channel lookup table: 256 entries
 * saying what each input level becomes. That is the whole trick, because a LUT
 * is the one shape both renderers speak natively:
 *
 * - on screen it *is* an SVG `feComponentTransfer` — `lutTable` prints it as
 *   the `tableValues` attribute, and the plate wears `filter: url(#…)`;
 * - at export it is applied per pixel with `applyLut` — plain array reads,
 *   no `ctx.filter` (Safari has none) and no image library (see the rule that
 *   pages stay on the client).
 *
 * One compile drives both, so the page you looked at and the page you export
 * cannot disagree about what the adjustment did.
 *
 * It lives in `shared/` for the reason `layers.ts` does: a bake worked out
 * anywhere else has to come out identical.
 */

/** The adjustments a layer can be, each with the numbers that define it. */
export type Adjustment =
  | {
    type: 'tone'
    /** Additive lift, minus a hundred to a hundred. */
    brightness: number
    /** Slope about middle grey, minus a hundred to a hundred. */
    contrast: number
  }
  | {
    type: 'levels'
    /** Input floor and ceiling, nought to two-five-five. */
    inBlack: number
    inWhite: number
    /** Midtone bend. One is straight; above brightens, below darkens. */
    gamma: number
    /** Output range the input is mapped onto. */
    outBlack: number
    outWhite: number
  }

export type AdjustmentType = Adjustment['type']

/** The menu: what can be added, in the order it is offered. */
export const ADJUSTMENTS: { type: AdjustmentType, label: string }[] = [
  { type: 'tone', label: 'Brightness / Contrast' },
  { type: 'levels', label: 'Levels' },
]

/** A fresh adjustment of a kind — always the identity, so adding one changes nothing yet. */
export function newAdjustment (type: AdjustmentType): Adjustment {
  return type === 'tone'
    ? { type: 'tone', brightness: 0, contrast: 0 }
    : { type: 'levels', inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * The adjustment as a function over one channel, nought to one in and out.
 *
 * Contrast is a slope about middle grey, asymmetric on purpose: down to nought
 * (flat grey) on the left of the slider but up to four on the right, because
 * "a bit more contrast" on a washed-out scan needs far more slope than "a bit
 * less" needs shallowness. Brightness is an additive lift of at most half the
 * range — a full-range shift turns the slider's ends into plain white and
 * plain black, which nobody has ever meant by brightness.
 *
 * Levels is the standard mapping: clamp to the input range, bend by gamma,
 * stretch onto the output range.
 */
export function adjustCurve (adjust: Adjustment): (v: number) => number {
  if (adjust.type === 'tone') {
    const slope = adjust.contrast >= 0 ? 1 + (adjust.contrast / 100) * 3 : 1 + adjust.contrast / 100
    const lift = (adjust.brightness / 100) * 0.5

    return (v) => (v - 0.5) * slope + 0.5 + lift
  }

  const floor = adjust.inBlack / 255
  // Never a zero span, so the curve stays a function when the sliders cross.
  const span = Math.max(1 / 255, (adjust.inWhite - adjust.inBlack) / 255)
  const out = adjust.outBlack / 255
  const reach = (adjust.outWhite - adjust.outBlack) / 255
  const bend = 1 / Math.max(0.01, adjust.gamma)

  return (v) => out + reach * clamp01((v - floor) / span) ** bend
}

/**
 * The adjustment compiled to a lookup table, already blended by its strength.
 *
 * Strength is the layer's opacity slider doing the one thing opacity can mean
 * for a row that draws nothing: how much of the effect to apply. Half strength
 * is halfway between the identity and the full curve — which is exactly what
 * half-fading a Photoshop adjustment layer does.
 */
export function adjustLut (adjust: Adjustment, strength = 1): number[] {
  const curve = adjustCurve(adjust)
  const lut: number[] = []

  for (let i = 0; i < 256; i++) {
    const v = i / 255

    lut.push(v + (clamp01(curve(v)) - v) * strength)
  }

  return lut
}

/** A LUT as `feComponentTransfer` wants it printed. */
export function lutTable (lut: number[]): string {
  return lut.map((v) => +v.toFixed(4)).join(' ')
}

/**
 * The same LUT applied to raw pixels — the export half of the bargain above.
 *
 * Alpha is left alone: an adjustment is about colour, and the transparent
 * surround of a patch must stay transparent however hard the curve is pushed.
 */
export function applyLut (data: Uint8ClampedArray, lut: number[]): void {
  const bytes = lut.map((v) => Math.round(v * 255))

  for (let i = 0; i < data.length; i += 4) {
    data[i] = bytes[data[i]!]!
    data[i + 1] = bytes[data[i + 1]!]!
    data[i + 2] = bytes[data[i + 2]!]!
  }
}
