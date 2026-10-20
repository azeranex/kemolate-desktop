/**
 * A stroke, from pointer to log and from log to pixels — one code path for
 * both, which is the property everything else leans on.
 *
 * Live painting runs `begin → lineTo… → end` off the pointer and hands back a
 * draft for the stroke log. Replay runs the same three calls off a stored row's
 * points. Same `dabSpots`, same stamps, same order — so the mark a collaborator
 * replays is the mark the painter saw, and a page rebuilt after undo is the
 * page as it was.
 *
 * The buffered path (brush and eraser) is the earlier build's coverage
 * pipeline, kept whole: the stroke accumulates *greatest* coverage in one
 * buffer, is turned into colour-with-alpha in another, and is laid onto the
 * layer against a `before` snapshot each batch — which is what keeps a soft
 * edge soft where dabs overlap, and what makes an in-progress stroke visible
 * without being committed. Heal and clone stamp straight onto the layer, as
 * they always did; their marks are not one flat colour, so coverage cannot
 * carry them.
 *
 * The one departure from the original: heal *records what it sampled*. Live,
 * each dab's ring median goes into `colours`; replayed, the colours are paid
 * back out by index instead of sampled again. Sampling reads the page as it
 * looks *now*, and "now" is the one thing a replay cannot have — a concurrent
 * stroke that ordered underneath would change the reading. Recorded, the
 * stroke is "lay these colours along this path", which replays exactly.
 */

import { coverageToAlpha, coverDisc, coverSweep, HARD, paintDisc, paintFromImage, reach } from './stamps'

import type { StrokeParams } from '~~/server/database'

export type PaintToolId = 'brush' | 'eraser' | 'clone' | 'heal'

/** A rectangle of the layer, in its pixels. */
export interface Box { x: number, y: number, w: number, h: number }

/**
 * The page under the paint with the paint laid over it — what the sampling
 * tools read. Given `region` and `into`, only that part of `into` is brought
 * up to date and `into` is handed back: see `replayRows`, which reuses one
 * picture for every clone stroke in a batch.
 */
export type BuildFlat = (region?: Box, into?: HTMLCanvasElement | null) => HTMLCanvasElement | null

export interface StrokeOpts {
  tool: PaintToolId
  /** Brush diameter, page pixels. */
  size: number
  /** 0 crisp .. 1 no edge at all. */
  softness: number
  /** #rrggbb, for the tools that lay one colour down. */
  colour: string
  /** Brush-to-source vector, fixed at stroke start. Clone only. */
  cloneOffset?: Point | null
  /** Replaying heal: the recorded samples. Absent live, and they get recorded. */
  colours?: string[]
}

/** What `end()` hands back — the log row, minus what the server adds. */
export interface StrokeDraftOut {
  tool: PaintToolId
  composite: string | null
  params: StrokeParams
  points: number[]
  x: number
  y: number
  w: number
  h: number
}

/** Longest heal stroke that still fits the route's `colours` cap. */
const MOST_DABS = 5000

/**
 * Most vertices a preview path is drawn with — see `preview`.
 *
 * Two hundred is far more than a line needs to look like the line it is, and
 * the point of a cap rather than a ratio is that the cost of drawing somebody
 * else's gesture stops rising with how long they have been drawing.
 */
const MOST_PREVIEW = 200

/** The square a replayed stroke's coverage is converted in — see `commit`. */
const TILE = 256

/** Room for any page's columns of tiles, so a tile's number is `row * this + column`. */
const TILE_COLUMNS_MAX = 4096

/** A coordinate as a row stores it: to a tenth of a pixel. */
const tenth = (v: number) => Math.round(v * 10) / 10

/**
 * A point as a row stores it — and so as the live stroke is drawn from.
 *
 * The row always kept its points to a tenth of a pixel while the live stroke
 * was drawn from wherever the pointer really was, so a stroke replayed was
 * drawn along a path up to a twentieth of a pixel off the one painted. Brush
 * and eraser never showed it. Clone and heal did, and badly: a clone lifts
 * each mark onto the pixel grid (`gridCopy`), where a twentieth is enough to
 * move a whole mark by a pixel, and heal pays its recorded colours back out
 * one per dab, where a path a shade longer or shorter spaces one more or one
 * fewer dab along a segment and every colour after it lands on the wrong one.
 * Measured on single strokes, a hard clone came back with 1,017 pixels changed
 * and a heal with 3,398, both by as much as 255. Rounded on the way in, the
 * live stroke is the row, and a replay is the stroke that was painted.
 */
const onRowGrid = (at: Point): Point => ({ x: tenth(at.x), y: tenth(at.y) })

export class PaintSession {
  /** The committed paint, and the visible element — strokes land here live. */
  private layer: HTMLCanvasElement

  /** The flattened page for sampling tools, built lazily per stroke. */
  private buildFlat: BuildFlat

  private flat: HTMLCanvasElement | null = null

  /** The layer as the stroke began, for re-laying the buffered stroke per batch. */
  private before = document.createElement('canvas')

  /** Greatest coverage per pixel, in the red channel — see `coverDisc`. */
  private cover = document.createElement('canvas')

  /**
   * The coverage buffer's context, made once and told what it is for.
   *
   * This is the canvas every batch reads back, and a canvas the browser has put
   * on the GPU has to be pulled down again for each read — a sync that lands on
   * whichever frame is unlucky. Asked for up front, it is kept where reading is
   * cheap: on a page-sized layer the worst frame of a stroke went from fifteen
   * milliseconds to two, with the median unchanged. Held as a field because the
   * flag is only honoured the first time a context is asked for, so it cannot be
   * left to whichever call site happens to run first.
   */
  private coverContext = this.cover.getContext('2d', { willReadFrequently: true })

  /** The coverage as colour-with-alpha, ready to composite. */
  private stroke = document.createElement('canvas')

  /** Scratch for the clone stamp, reused rather than made per mark. */
  private scratch = document.createElement('canvas')

  /**
   * The page a *watched* clone stroke copies from, kept between frames.
   *
   * Somebody else's clone stroke has to be previewed against this browser's own
   * composite, and building that is the expensive half of `buildFlat`. A live
   * gesture arrives twenty times a second and each frame repaints the whole
   * ghost, so building it per frame would put the cost back that `preview`
   * exists to avoid. It is dropped whenever the committed log moves — see
   * `dropGhostSource` — which is the only thing that can make it wrong.
   */
  private ghostSource: HTMLCanvasElement | null = null

  private opts: StrokeOpts | null = null

  private last: Point | null = null

  private points: number[] = []

  private bounds: Bounds | null = null

  /** Heal's samples: recorded live, consumed by index on replay. */
  private colours: string[] = []

  private dabAt = 0

  /**
   * Whether the stroke is being laid down in one go rather than watched.
   *
   * Set only by `replay`. It turns the per-segment composite off so the whole
   * stroke's coverage is gathered first and converted once — see
   * `bufferedSegment` and `commit`.
   */
  private bulk = false

  /**
   * The tiles a stroke laid down in one go has actually marked, as
   * `row * TILE_COLUMNS_MAX + column` — see `commit`.
   */
  private touched = new Set<number>()

  /**
   * Whether `replayRows` is laying a log down — which keeps the three stroke
   * buffers between its strokes rather than letting them go after each.
   */
  private batch = false

  /**
   * The part of the layer the stroke being replayed can reach, where that is
   * known before it is drawn (`replayRows`) — null for all of it, which is what
   * a live stroke always is.
   */
  private reachBox: Box | null = null

  /**
   * In a batch, what the clone stroke being replayed copies from — its reach,
   * moved by its offset — and the one flat picture every clone stroke in the
   * batch brings up to date there (`BuildFlat`).
   */
  private sourceBox: Box | null = null

  private batchFlat: HTMLCanvasElement | null = null

  /**
   * Told the rectangle of the layer each write changed, in layer pixels — so
   * the page engine, which draws this layer, uploads what changed and not the
   * whole page every frame of a stroke. See `utils/raster/engine/surfaces.ts`.
   */
  private onDirty: (x: number, y: number, w: number, h: number) => void

  constructor (
    layer: HTMLCanvasElement,
    buildFlat: BuildFlat,
    onDirty: (x: number, y: number, w: number, h: number) => void = () => {},
  ) {
    this.layer = layer
    this.buildFlat = buildFlat
    this.onDirty = onDirty
  }

  private get radius () {
    return (this.opts?.size ?? 0) / 2
  }

  private get buffered () {
    return this.opts?.tool === 'brush' || this.opts?.tool === 'eraser'
  }

  /** Whether a stroke is open — a pointerup with none open is nothing. */
  get active () {
    return this.opts !== null
  }

  /**
   * Open a stroke. False when the tool cannot mark yet — a clone with no
   * source anchored — so the caller can say so instead of dragging silence.
   */
  begin (press: Point, opts: StrokeOpts): boolean {
    const at = onRowGrid(press)
    const sampling = opts.tool === 'clone' || (opts.tool === 'heal' && !opts.colours)

    if (sampling) {
      // A clone in a batch reads only its source box, so only that of the
      // picture is made — see `replayRows`.
      this.flat = this.sourceBox
        ? (this.batchFlat = this.buildFlat(this.sourceBox, this.batchFlat))
        : this.buildFlat()

      if (opts.tool === 'clone' && (!this.flat || !opts.cloneOffset)) return false
    }

    this.opts = opts
    this.points = [at.x, at.y]
    this.bounds = null
    this.colours = []
    this.dabAt = 0
    this.last = null

    if (this.buffered) {
      const { width, height } = this.layer

      // Kept from the stroke before, in a batch (`replayRows`): sized already,
      // so only what this stroke can reach is set up again below.
      const kept = this.batch && [this.before, this.cover, this.stroke]
        .every((buffer) => buffer.width === width && buffer.height === height)

      if (!kept) {
        for (const buffer of [this.before, this.cover, this.stroke]) {
          buffer.width = width
          buffer.height = height
        }
      }

      // Outside the box nothing is read — every mark, and so every tile
      // `commit` lays down, is inside it — so what the buffers hold there,
      // another stroke's leftovers or nothing, does not matter.
      const { x, y, w, h } = this.reachBox ?? { x: 0, y: 0, w: width, h: height }
      const bc = this.before.getContext('2d')

      if (kept) {
        bc?.clearRect(x, y, w, h)
        this.stroke.getContext('2d')?.clearRect(x, y, w, h)
      }

      bc?.drawImage(this.layer, x, y, w, h, x, y, w, h)

      const cc = this.coverContext

      if (cc) {
        // Opaque black, so `lighten` is a plain per-channel maximum — and then
        // `lighten` itself, which is the whole mechanism. Without it the dabs
        // composite source-over, and every dab's dark rim stamps over its
        // neighbour's bright core: the coverage comes out near-black
        // everywhere, and the stroke paints at one-twentieth opacity.
        // (Resizing the buffer resets context state, so this is per stroke; a
        // kept buffer still holds the last stroke's `lighten`, so the fill
        // below says what it wants.)
        cc.globalCompositeOperation = 'source-over'
        cc.fillStyle = '#000'
        cc.fillRect(x, y, w, h)
        cc.globalCompositeOperation = 'lighten'
      }
    }

    // The first mark lands at the press, not at the first move — a click is
    // the shortest stroke there is.
    this.segment(at, at)
    this.last = at

    return true
  }

  lineTo (to: Point) {
    if (!this.opts || !this.last) return

    const at = onRowGrid(to)

    this.segment(this.last, at)
    this.last = at
    this.points.push(at.x, at.y)
  }

  /**
   * What the stroke says so far, without closing it.
   *
   * For sending a gesture to the people watching it happen — see `SwarmLive`.
   * `end` is the only other way to get a stroke out of a session and it is
   * destructive: it tears down the buffers and clears the stroke, which is
   * exactly right at the end of a gesture and useless in the middle of one.
   *
   * No box, unlike `end`. A bounding rectangle is for filing the row and this
   * is never filed; the receiving canvas replays from the points like any
   * other replay, and the real row with its real box follows on release.
   */
  peek (): Pick<StrokeDraftOut, 'tool' | 'composite' | 'params' | 'points'> | null {
    const opts = this.opts

    if (!opts || !this.bounds) return null

    return {
      tool: opts.tool,
      composite: opts.tool === 'eraser' ? 'destination-out' : null,
      params: this.settings(opts),
      points: this.points.map(tenth),
    }
  }

  /** What a stroke was drawn with, as a row records it. */
  private settings (opts: StrokeOpts): StrokeParams {
    return {
      size: opts.size,
      softness: opts.softness,
      colour: opts.colour,
      ...(opts.cloneOffset ? { cloneOffset: { x: opts.cloneOffset.x, y: opts.cloneOffset.y } } : {}),
      ...(this.colours.length ? { colours: this.colours } : {}),
    }
  }

  /**
   * Close the stroke and hand back its log row — or null for a stroke that
   * never marked anything, which is not worth a row.
   */
  end (): StrokeDraftOut | null {
    const opts = this.opts

    if (!opts) return null

    const bounds = this.bounds

    this.opts = null
    this.last = null
    this.flat = null

    // Let the stroke buffers go: they are the size of the page, and holding
    // three of them between strokes is most of a scan's worth of memory. Not
    // inside a batch, which lets them go once at its end.
    if (!this.batch) this.releaseBuffers()

    if (!bounds) return null

    const params = this.settings(opts)

    return {
      tool: opts.tool,
      composite: opts.tool === 'eraser' ? 'destination-out' : null,
      params,
      points: this.points.map(tenth),
      x: Math.floor(bounds.x0),
      y: Math.floor(bounds.y0),
      w: Math.ceil(bounds.x1 - bounds.x0),
      h: Math.ceil(bounds.y1 - bounds.y0),
    }
  }

  /**
   * Somebody else's stroke, roughly, in one pass.
   *
   * For a mark that is still being made and is about to be replaced by the real
   * thing — see `SwarmLive`. It draws one path: no dab loop, no coverage
   * buffer, no readback.
   *
   * `replay` is the honest version and is far too expensive to run per frame.
   * Its cost is per *segment*, and each segment does a `getImageData` — a
   * GPU-to-CPU sync — plus a per-pixel pass to turn coverage into alpha. Replaying
   * a gesture means paying that for every point in it, on every frame, while the
   * point count grows: the cost of watching somebody draw rises with the square
   * of how long they have been drawing. A wide eraser made it plainest, because
   * the readback is over the dab's bounding box and a wide sweep reads back a
   * lot of page.
   *
   * What is given up is exactness — a round-capped line with a blur standing in
   * for the feather, rather than accumulated coverage — and it is the right
   * thing to give up. This is on screen for a moment, and the moment it ends the
   * committed row replaces it with the mark as it truly is. A preview that is
   * slightly wrong for a third of a second is worth far more than an exact one
   * that arrives late.
   */
  preview (row: { tool: string, params: StrokeParams, points: number[] }) {
    const c = this.layer.getContext('2d')
    const points = row.points

    if (!c || points.length < 2) return

    const size = row.params.size ?? 24
    const soft = row.params.softness ?? 0

    c.save()

    c.globalCompositeOperation = row.tool === 'eraser' ? 'destination-out' : 'source-over'
    c.strokeStyle = row.params.colour ?? '#ffffff'

    /*
     * A clone is not a colour, so the line is filled with the page instead.
     *
     * Every other tool lays down something chosen, and one `strokeStyle` says
     * it. A clone lays down whatever is somewhere else — so a preview drawn the
     * ordinary way showed a watcher a solid stroke in the *painter's* colour,
     * which is not a rough version of the mark, it is a different mark. It
     * looked most like a bug when the colour happened to be white.
     *
     * A pattern of the flattened page, translated by minus the offset, puts the
     * source pixels under the path exactly where the committed replay will put
     * them — `gridCopy` is where that sign comes from: a destination pixel reads
     * from itself plus the offset, so the image has to move the other way.
     * Rounded for the reason that function gives, so the preview and the mark
     * that replaces it are not half a pixel apart.
     *
     * One pattern and one path — the cost this whole method exists to keep.
     */
    if (row.tool === 'clone') {
      const offset = row.params.cloneOffset
      const source = offset ? (this.ghostSource ??= this.buildFlat()) : null
      const pattern = source && c.createPattern(source, 'no-repeat')

      if (!offset || !pattern) {
        // Nothing honest to draw. Better a watcher sees the stroke appear on
        // release than sees a line of the wrong colour for a third of a second.
        c.restore()

        return
      }

      pattern.setTransform(new DOMMatrix().translate(-Math.round(offset.x), -Math.round(offset.y)))
      c.strokeStyle = pattern
    }

    c.lineWidth = size
    c.lineCap = 'round'
    c.lineJoin = 'round'

    /*
     * Softness as translucency, not as a blur.
     *
     * `ctx.filter = 'blur(...)'` is the obvious way to suggest a feathered edge
     * and it is a trap. The radius scales with the brush, so a wide soft brush
     * asks for a blur tens of pixels across, and the browser answers by
     * allocating intermediate surfaces the size of the page — per frame, for a
     * path that spans the whole stroke. It is enough to take the GPU down, and
     * it did: releasing a wide brush froze the machine, because the final frame
     * carries the longest path there has been.
     *
     * Alpha costs nothing and says the same thing well enough for a preview
     * that lasts a moment. The committed replay does the real feather.
     */
    c.globalAlpha = 1 - Math.min(0.45, soft * 0.45)

    /*
     * At most this many points, evenly sampled.
     *
     * A long sweep can carry thousands, and a preview gains nothing from the
     * ones between: the line is the same line at a tenth of the vertices, and
     * the cost of the path stops growing with how long somebody has been
     * drawing. The committed row keeps every point.
     */
    const step = Math.max(2, Math.ceil(points.length / 2 / MOST_PREVIEW) * 2)

    c.beginPath()
    c.moveTo(points[0]!, points[1]!)

    for (let i = step; i < points.length; i += step) c.lineTo(points[i]!, points[i + 1]!)

    // The end, whatever the sampling skipped, so the line reaches where the
    // hand actually is rather than stopping short of it.
    c.lineTo(points[points.length - 2]!, points[points.length - 1]!)

    c.stroke()
    c.restore()
  }

  /** Give the three page-sized stroke buffers back, and a batch's flat picture. */
  private releaseBuffers () {
    for (const buffer of [this.before, this.cover, this.stroke]) {
      buffer.width = 0
      buffer.height = 0
    }

    if (this.batchFlat) this.batchFlat.width = 0

    this.batchFlat = null
  }

  /**
   * Many stored strokes laid down in order — a surface drawn from its log.
   *
   * `replay` one at a time, but with the stroke buffers kept for the whole
   * batch, and each stroke setting up only the part of them it can reach.
   * Opening a buffered stroke sizes three page-sized buffers, copies the whole
   * layer into one and fills another — on a 3732 × 5197 page that is three
   * 78 MB allocations and two full-page passes, *per stroke*, however small the
   * stroke. Page 6 of the large-page test chapter held 24 strokes, mostly a
   * few hundred pixels across, and drawing them took 285 ms; that was the
   * retouching arriving 0.4 s after the page did on every turn to it.
   *
   * The pixels are the same: what each stroke reads and writes is inside its
   * reach, and inside its reach the buffers start exactly as a fresh stroke's
   * would. A live stroke does not come through here and is unchanged.
   *
   * A clone stroke is the same story told of what it copies from. Opening one
   * built a fresh page-sized picture of the page and the paint on it
   * (`buildFlat`) — two full-page draws a stroke, which the GPU paid for in
   * one frame of 176 ms after five clone strokes on that page. It copies from
   * its points moved by its offset, grown by its reach, and nowhere else; so
   * a batch keeps one picture and each clone stroke redraws that box of it.
   */
  replayRows (rows: readonly { tool: string, params: StrokeParams, points: number[] }[]) {
    this.batch = true

    try {
      for (const row of rows) this.replay(row)
    } finally {
      this.batch = false
      this.reachBox = null
      this.sourceBox = null
      this.releaseBuffers()
    }
  }

  /**
   * What a stored stroke can touch: its points, grown by the reach of its
   * brush (`reach`, what every mark and `commit`'s bounds are measured by),
   * and a few pixels more for `commit`'s own margin and the edge of a disc.
   */
  private reachOf (row: { params: StrokeParams, points: number[] }): Box | null {
    const far = reach((row.params.size ?? 24) / 2, row.params.softness ?? 0) + 4
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity

    for (let i = 0; i + 1 < row.points.length; i += 2) {
      x0 = Math.min(x0, row.points[i]!)
      x1 = Math.max(x1, row.points[i]!)
      y0 = Math.min(y0, row.points[i + 1]!)
      y1 = Math.max(y1, row.points[i + 1]!)
    }

    if (!Number.isFinite(x0)) return null

    const left = Math.max(0, Math.floor(x0 - far))
    const top = Math.max(0, Math.floor(y0 - far))
    const right = Math.min(this.layer.width, Math.ceil(x1 + far))
    const bottom = Math.min(this.layer.height, Math.ceil(y1 + far))

    return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null
  }

  /**
   * Where a clone stroke copies from: its reach moved by its offset, a pixel
   * wider for the rounding `gridCopy` does, and inside the layer.
   */
  private sourceOf (box: Box | null, offset: Point | null | undefined): Box | null {
    if (!box || !offset) return null

    const left = Math.max(0, Math.floor(box.x + offset.x) - 2)
    const top = Math.max(0, Math.floor(box.y + offset.y) - 2)
    const right = Math.min(this.layer.width, Math.ceil(box.x + box.w + offset.x) + 2)
    const bottom = Math.min(this.layer.height, Math.ceil(box.y + box.h + offset.y) + 2)

    // Wholly off the page: nothing to copy, and a stroke that would copy
    // nothing still opens — an empty box rather than null, which would mean
    // "the whole page".
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
  }

  /**
   * A stored stroke, laid back down — the same calls the pointer makes, driven
   * from the row instead.
   */
  replay (row: { tool: string, params: StrokeParams, points: number[] }) {
    const params = row.params

    // Known before it is drawn, where a batch can use it — see `replayRows`.
    this.reachBox = this.batch ? this.reachOf(row) : null
    this.sourceBox = this.batch && row.tool === 'clone' ? this.sourceOf(this.reachBox, params.cloneOffset) : null

    const opened = this.begin(
      { x: row.points[0] ?? 0, y: row.points[1] ?? 0 },
      {
        tool: row.tool as PaintToolId,
        size: params.size ?? 24,
        softness: params.softness ?? 0,
        colour: params.colour ?? '#ffffff',
        cloneOffset: params.cloneOffset ?? null,
        colours: params.colours,
      },
    )

    if (!opened) return

    // Gathered, then composited once — see `bulk`. Only for the buffered tools:
    // clone and heal build their marks a dab at a time and have no coverage
    // pass to defer.
    this.bulk = this.buffered
    this.touched.clear()

    // The press's own mark, which `begin` laid before `bulk` was set.
    if (this.bulk && this.bounds) this.touch(this.bounds)

    for (let i = 2; i < row.points.length; i += 2) {
      this.lineTo({ x: row.points[i]!, y: row.points[i + 1]! })
    }

    if (this.bulk) {
      this.bulk = false
      this.commit()
    }

    this.end()
  }

  /**
   * Put a gathered stroke onto the layer in one pass.
   *
   * The same three steps `bufferedSegment` ends with, over the whole stroke's
   * bounds instead of one segment's: read the coverage back as alpha, restore
   * the layer as it was inside that box, composite the stroke over it.
   *
   * One `getImageData` for a stroke rather than one per segment, which for a
   * long sweep is the difference between a hitch and none. The picture is
   * identical — the coverage was accumulated with `lighten`, so gathering it
   * first changes nothing about what it says.
   *
   * ## Only the tiles it touched
   *
   * "The whole stroke's bounds" was the next cost, and for the strokes this
   * brush is used for most — a wide brush run round the edge of a page to clean
   * the margin — it was the whole page: a frame's bounding box is everything
   * inside the frame. On a 2654×4025 page that was 160 ms a stroke, every time
   * the page was drawn, converting ten million pixels of which the stroke had
   * touched a fraction. So the marks note which `TILE`-sized squares they reach
   * as they are gathered (`touch`), and only those are converted and laid down,
   * a row of adjacent tiles at a time. Outside them the layer is left exactly
   * as it was, which is what the coverage there already said.
   */
  private commit () {
    const bounds = this.bounds

    if (!bounds || !this.opts) return

    const x0 = Math.max(0, Math.floor(bounds.x0) - 2)
    const y0 = Math.max(0, Math.floor(bounds.y0) - 2)
    const x1 = Math.min(this.layer.width, Math.ceil(bounds.x1) + 2)
    const y1 = Math.min(this.layer.height, Math.ceil(bounds.y1) + 2)

    if (x1 <= x0 || y1 <= y0) return

    // Nothing noted — a stroke laid by a path that does not touch — is the
    // whole box, as it always was.
    if (!this.touched.size) {
      this.layDown(x0, y0, x1 - x0, y1 - y0)

      return
    }

    const rows = new Map<number, number[]>()

    for (const tile of this.touched) {
      const row = Math.floor(tile / TILE_COLUMNS_MAX)

      rows.set(row, [...(rows.get(row) ?? []), tile % TILE_COLUMNS_MAX])
    }

    for (const [row, columns] of rows) {
      columns.sort((a, b) => a - b)

      // Runs of neighbouring tiles become one strip, so a stroke along a row
      // is one read rather than one per tile.
      for (let at = 0; at < columns.length;) {
        let end = at

        while (end + 1 < columns.length && columns[end + 1] === columns[end]! + 1) end++

        const sx = Math.max(x0, columns[at]! * TILE)
        const sy = Math.max(y0, row * TILE)
        const ex = Math.min(x1, (columns[end]! + 1) * TILE)
        const ey = Math.min(y1, (row + 1) * TILE)

        if (ex > sx && ey > sy) this.layDown(sx, sy, ex - sx, ey - sy)

        at = end + 1
      }
    }
  }

  /** Note the tiles a batch of marks reached, a shade wider — see `commit`. */
  private touch (box: Bounds) {
    const c0 = Math.max(0, Math.floor((box.x0 - 2) / TILE))
    const c1 = Math.floor((box.x1 + 2) / TILE)
    const r0 = Math.max(0, Math.floor((box.y0 - 2) / TILE))
    const r1 = Math.floor((box.y1 + 2) / TILE)

    for (let row = r0; row <= r1; row++) {
      for (let column = c0; column <= c1; column++) this.touched.add(row * TILE_COLUMNS_MAX + column)
    }
  }

  /** Convert one rectangle of coverage and lay it over the layer as it was. */
  private layDown (bx: number, by: number, bw: number, bh: number) {
    const c = this.layer.getContext('2d')
    const cc = this.coverContext
    const sc = this.stroke.getContext('2d')

    if (!c || !cc || !sc || !this.opts) return

    coverageToAlpha(cc, sc, rgbOf(this.opts.colour), bx, by, bw, bh)

    c.save()
    c.beginPath()
    c.rect(bx, by, bw, bh)
    c.clip()
    c.globalCompositeOperation = 'copy'
    c.drawImage(this.before, bx, by, bw, bh, bx, by, bw, bh)
    c.globalCompositeOperation = this.opts.tool === 'eraser' ? 'destination-out' : 'source-over'
    c.drawImage(this.stroke, bx, by, bw, bh, bx, by, bw, bh)
    c.restore()
    this.onDirty(bx, by, bw, bh)
  }

  /* ---------- marks ---------- */

  private segment (from: Point, to: Point) {
    const opts = this.opts

    if (!opts) return

    const c = this.layer.getContext('2d')

    if (!c) return

    const r = this.radius
    const soft = opts.softness

    if (this.buffered) {
      this.bufferedSegment(c, from, to, r, soft)

      return
    }

    c.save()

    // What the mark reaches, not the radius it is named for — a soft stamp
    // spills past `r` and its bounds have to hold the spill. See `reach`.
    const far = reach(r, soft)
    let touched: ReturnType<typeof grownBounds> | null = null

    for (const spot of dabSpots(from, to, r)) {
      if (this.dabAt >= MOST_DABS) break

      this.bounds = grownBounds(this.bounds, spot.x, spot.y, far)
      touched = grownBounds(touched, spot.x, spot.y, far)

      if (opts.tool === 'heal') {
        // Healing always feathers: a hard-edged patch of flat tone reads as a
        // disc stamped on the page, however crisp the brush is set.
        const recorded = opts.colours?.[this.dabAt]
        const colour = recorded ? rgbOf(recorded) : this.ringColour(spot.x, spot.y, r)

        if (colour) {
          if (!opts.colours) this.colours.push(hexOf(colour))

          paintDisc(c, spot.x, spot.y, r, colour, Math.max(0.3, soft))
        }
      } else if (opts.tool === 'clone' && this.flat && opts.cloneOffset) {
        paintFromImage(c, this.flat, spot.x, spot.y, r, opts.cloneOffset, soft, this.scratch)
      }

      this.dabAt++
    }

    c.restore()

    if (touched) this.onDirty(touched.x0 - 1, touched.y0 - 1, touched.x1 - touched.x0 + 2, touched.y1 - touched.y0 + 2)
  }

  /**
   * Brush and eraser, by way of the coverage buffers — the earlier build's
   * `dab` fast path, kept whole. Coverage first, greatest-of; then the touched
   * patch is rebuilt: the layer as it was, with the whole stroke so far laid
   * over it once. Only this batch's patch can have changed, because coverage
   * only ever grows where a new mark lands.
   */
  private bufferedSegment (
    c: CanvasRenderingContext2D,
    from: Point,
    to: Point,
    r: number,
    soft: number,
  ) {
    const cc = this.coverContext
    const sc = this.stroke.getContext('2d')

    if (!cc || !sc) return

    let batch: Bounds | null = null

    /**
     * What the marks in this batch actually reach — `reach`, not `r`.
     *
     * Load-bearing, and not merely tidy. The patch below is a *clip*: the
     * layer is rebuilt inside it and nothing outside it is touched. Measured
     * to the radius while the feather ran half again as far, every batch cut
     * its own soft edge off along a straight line — and since the patch is the
     * bounding box of one segment's dabs, the line moved whenever the stroke
     * changed direction. A sweeping curve was fine and a sharp corner came out
     * with the halo sliced into rectangles, which is precisely where it looked
     * worst.
     */
    const far = reach(r, soft)

    if (soft < HARD) {
      // One swept disc rather than a row of them — see `coverSweep`.
      coverSweep(cc, from, to, r, soft)

      for (const end of [from, to]) {
        batch = grownBounds(batch, end.x, end.y, far)
        this.bounds = grownBounds(this.bounds, end.x, end.y, far)
      }
    } else {
      for (const spot of dabSpots(from, to, r, DAB_STEP_SMOOTH)) {
        coverDisc(cc, spot.x, spot.y, r, soft)
        batch = grownBounds(batch, spot.x, spot.y, far)
        this.bounds = grownBounds(this.bounds, spot.x, spot.y, far)
      }
    }

    if (!batch) return

    if (this.bulk) this.touch(batch)

    /*
     * Laying a stroke down all at once defers this to the end.
     *
     * The conversion below is what costs: a `getImageData` — a GPU-to-CPU sync
     * — and a per-pixel pass, once per batch. Doing it per segment is right
     * while somebody is drawing, because each one is a frame they have to see.
     * A replay is not watched: only its result is, so hundreds of conversions
     * produce hundreds of intermediate pictures nobody ever looks at.
     *
     * Deferring is exact rather than approximate, and that is the whole reason
     * it is allowed: coverage accumulates with `lighten`, a per-channel maximum,
     * which does not care what order it is written in. Every dab first, one
     * conversion after — see `commit`.
     */
    if (this.bulk) return

    // A mark's rim reaches a shade past its radius, and the coverage has to be
    // read back a pixel wider than it was written to catch it.
    const bx = Math.max(0, Math.floor(batch.x0) - 2)
    const by = Math.max(0, Math.floor(batch.y0) - 2)
    const bw = Math.min(this.layer.width, Math.ceil(batch.x1) + 2) - bx
    const bh = Math.min(this.layer.height, Math.ceil(batch.y1) + 2) - by

    coverageToAlpha(cc, sc, rgbOf(this.opts!.colour), bx, by, bw, bh)

    c.save()
    // `copy` clears whatever it does not draw over, so it has to be fenced
    // into this patch or the first mark would wipe the rest of the layer.
    c.beginPath()
    c.rect(bx, by, bw, bh)
    c.clip()
    c.globalCompositeOperation = 'copy'
    c.drawImage(this.before, bx, by, bw, bh, bx, by, bw, bh)
    c.globalCompositeOperation = this.opts!.tool === 'eraser' ? 'destination-out' : 'source-over'
    c.drawImage(this.stroke, bx, by, bw, bh, bx, by, bw, bh)
    c.restore()
    this.onDirty(bx, by, bw, bh)
  }

  /* ---------- sampling ---------- */

  /**
   * The colour just outside the brush. Taken as a per-channel median of a ring
   * of samples, so one dark glyph still caught in the ring cannot drag the
   * result grey — on comic pages the surrounding tone is overwhelmingly
   * uniform, and the median lands on it exactly.
   */
  ringColour (x: number, y: number, r: number): [number, number, number] | null {
    const el = this.flat ?? this.buildFlat()
    const c = el?.getContext('2d')

    if (!c || !el) return null

    const chan: [number[], number[], number[]] = [[], [], []]

    for (const mul of [1.35, 1.7]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2
        const sx = Math.round(x + Math.cos(a) * r * mul)
        const sy = Math.round(y + Math.sin(a) * r * mul)

        if (sx < 0 || sy < 0 || sx >= el.width || sy >= el.height) continue

        const d = c.getImageData(sx, sy, 1, 1).data

        chan[0].push(d[0]!)
        chan[1].push(d[1]!)
        chan[2].push(d[2]!)
      }
    }

    if (!chan[0].length) return null

    const mid = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]!

    return [mid(chan[0]), mid(chan[1]), mid(chan[2])]
  }

  /**
   * Forget the composite a watched clone stroke is previewed against.
   *
   * Called when the committed log moves, which is the one thing that changes
   * what a clone would copy. Not called per live frame, deliberately: that is
   * the whole point of caching it — see `ghostSource`.
   */
  dropGhostSource () {
    this.ghostSource = null
  }

  /**
   * The page as the sampling tools see it — everything under the brush, flat.
   *
   * Built on demand and kept only for the length of a stroke, so a caller
   * outside one gets a fresh composite. That is what the clone stamp's preview
   * wants: it captures the page at the moment a source is anchored, and a
   * cached composite from some earlier stroke would show it the wrong page.
   */
  flatten (): HTMLCanvasElement | null {
    return this.flat ?? this.buildFlat()
  }

  /** One pixel of the flattened page, for the colour picker. */
  sample (x: number, y: number): string | null {
    const el = this.buildFlat()
    const c = el?.getContext('2d')

    if (!c) return null

    const d = c.getImageData(Math.round(x), Math.round(y), 1, 1).data

    return hexOf([d[0]!, d[1]!, d[2]!])
  }
}
