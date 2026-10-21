import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PaintToolId } from '~/utils/paint/session'

import { PaintSession } from '~/utils/paint/session'

/**
 * A stroke replayed is the stroke that was painted.
 *
 * The session's whole promise (see its header): live painting and replay run
 * the same calls, so a surface rebuilt from its log is the surface as it was
 * painted. It was not quite kept. The live stroke drew from wherever the
 * pointer really was, and the row it filed kept its points to a tenth of a
 * pixel — so a replay walked a path up to a twentieth of a pixel off. Brush and
 * eraser never showed it; a clone lifts each mark onto the pixel grid, where
 * that moved whole marks by a pixel, and heal pays its recorded colours back
 * one per dab, where it put colours on the wrong dabs. Measured on single
 * strokes: a thousand pixels changed by a clone, three thousand by a heal.
 *
 * Seam: `PaintSession` — `begin`/`lineTo`/`end` as the pointer drives it, then
 * `replay` and `replayRows` on the row that came out. happy-dom's canvas has
 * no 2D context, so each canvas gets a stand-in that writes down where every
 * mark was put; the two drawings are compared as those lists.
 */

const platform = { getContext: HTMLCanvasElement.prototype.getContext }

/** What the layer was asked to draw, in order: the geometry of every mark. */
let drawn: string[] = []

/** Anything a context call hands back — a gradient, image data — that is itself fine to call. */
const inert: unknown = new Proxy(() => {}, {
  get: (_, name) => (name === 'data' ? new Uint8ClampedArray(4) : inert),
  apply: () => inert,
})

const GEOMETRY = new Set(['arc', 'drawImage', 'moveTo', 'lineTo', 'rect', 'fillRect', 'clearRect'])

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const layer = this.dataset.layer === 'yes'

    return new Proxy({}, {
      get: (_, name) => {
        if (name === 'canvas') return this
        if (name === 'getImageData') return () => ({ data: new Uint8ClampedArray(4).fill(200) })

        return (...args: unknown[]) => {
          if (layer && GEOMETRY.has(String(name))) {
            drawn.push(`${String(name)}(${args.filter((arg) => typeof arg === 'number').map((n) => (n as number).toFixed(4)).join(',')})`)
          }

          return inert
        }
      },
      set: () => true,
    })
  } as unknown as typeof platform.getContext
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = platform.getContext
})

function session () {
  const layer = document.createElement('canvas')

  layer.width = 400
  layer.height = 300
  layer.dataset.layer = 'yes'

  const flat = () => {
    const canvas = document.createElement('canvas')

    canvas.width = 400
    canvas.height = 300

    return canvas
  }

  return new PaintSession(layer, flat)
}

/** A path the way a pointer lays one down: nowhere near the tenth-of-a-pixel grid. */
const path = Array.from({ length: 12 }, (_, i) => ({ x: 40.123456 + i * 17.3791, y: 90.987654 + (i % 4) * 6.4417 }))

/** Paint a stroke the way the pointer does, and hand back the row and what was drawn. */
function paintLive (tool: PaintToolId, softness: number) {
  const live = session()

  drawn = []
  live.begin(path[0]!, { tool, size: 24, softness, colour: '#ff00ff', cloneOffset: tool === 'clone' ? { x: 120.4567, y: 30.1234 } : null })

  for (const at of path.slice(1)) live.lineTo(at)

  const row = live.end()!

  return { row, marks: drawn }
}

describe('a replayed stroke', () => {
  // Clone and heal stamp straight onto the layer a mark at a time, live and
  // replayed alike, so the marks themselves can be compared. Brush and eraser
  // cannot be, and need not be: live they lay a stroke down a segment at a
  // time and a replay lays it down once (`commit`), which is the same picture
  // by a different list of calls — and they were never the ones that drifted.
  for (const [tool, softness] of [['clone', 0], ['clone', 0.65], ['heal', 0.65], ['heal', 0]] as const) {
    it(`draws the marks the live ${tool} stroke drew (softness ${softness})`, () => {
      const { row, marks } = paintLive(tool, softness)

      drawn = []
      session().replay(row)

      expect(drawn).toEqual(marks)
    })
  }

  it('draws the same marks laid down in a batch as one at a time', () => {
    const { row } = paintLive('clone', 0)

    drawn = []
    session().replay(row)

    const single = drawn

    drawn = []
    session().replayRows([row])

    expect(drawn).toEqual(single)
  })
})
