/**
 * A gesture in flight, sent and received — the half of a stroke that is not a
 * record of anything.
 *
 * Everything here is about the moment between a hand going down and the row it
 * becomes. It is deliberately separate from `utils/strokes.ts`, which is about
 * the row: that one has to be right, this one only has to be quick, and losing
 * a frame of it costs nothing because the next supersedes it and release writes
 * the truth by the ordinary road.
 *
 * Pulled out of `CanvasPaint` so that anything drawing on a surface can have
 * it. The mask brush has none today — it syncs only on release, which is the
 * one thing about mask corrections that still feels unlike painting.
 *
 * What it does not do is draw. The consumer owns its own rendering and watches
 * `drawing`; a paint canvas replays these through `PaintSession.preview`, and a
 * mask would rasterise them its own way.
 */
import type { StrokeParams } from '~~/server/database'

/** Somebody's hand, mid-stroke. */
export interface Ghost {
  tool: string
  composite?: string | null
  params: StrokeParams
  points: number[]
  /**
   * Whose paint client drew it, and which stroke.
   *
   * Not the same as the peer id this is filed under: that is a connection, and
   * one person with two tabs open is two hands. These two are what recognise
   * the *row* when it arrives — see `retire`.
   */
  clientId: string
  seq: number
  /** The hand has lifted; this is waiting for its row. */
  ending?: boolean
}

/**
 * How often to tell the room what a hand is doing.
 *
 * Pointer moves arrive per frame and faster with coalescing. Twenty a second is
 * past the point anybody can see the difference and an order of magnitude less
 * traffic; the frame that ends a gesture ignores the clock, because that is the
 * one that has to be right.
 */
const EVERY = 50

/** How long a finished gesture waits for a row that may never arrive. */
const ORPHANED = 8000

/** Where a hand is drawing, and which gestures are worth watching. */
export interface LiveWhere {
  /** The surface this hand paints on. Null while there is nowhere to send. */
  surface: Ref<number | null>
  /** The page it is on, and the surface's key — sent so others can place it. */
  page: Ref<number | null>
  key: Ref<string>
  clientId: Ref<string>
  /**
   * Which of other people's gestures to draw.
   *
   * A paint canvas owns one surface and wants only that one, which is the
   * default. The mask brush is a single canvas over every block on a page, so
   * a gesture on any of that page's mask surfaces belongs to it — including
   * balloons this browser has never touched, which is exactly the case that
   * cannot be answered by comparing surface ids.
   */
  accepts?: (live: { surfaceId: number, pageId: number, key: string }) => boolean
}

export function useLiveStrokes (where: LiveWhere) {
  const { surface: surfaceId, clientId } = where
  const route = useRoute()
  const { peers } = useSwarm()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Gestures other people are making, by the connection making them. */
  const drawing = ref<Record<string, Ghost>>({})

  /** How many of this hand's points the room has already been told about. */
  let told = 0

  let last = 0

  /**
   * The seq this gesture will claim, fixed when it starts.
   *
   * Sent ahead of the row so the drawing can be recognised when its row turns
   * up. Read once at the start rather than per frame, because the log moves
   * when anybody's stroke lands and the number announced has to be the one the
   * row is finally written with.
   */
  const seq = ref(0)

  /**
   * Whether somebody else's gesture belongs on this canvas.
   *
   * Defaults to "the surface I am on", which is what a paint canvas wants and
   * what this used to do outright.
   */
  const mine = (live: { surfaceId: number, pageId: number, key: string }) =>
    (where.accepts ? where.accepts(live) : live.surfaceId === surfaceId.value)

  /** A fresh gesture has told the room nothing yet. */
  function begin (claiming: number) {
    told = 0
    last = 0
    seq.value = claiming
  }

  /**
   * Say what this hand is doing — the new part of it, or all of it at the end.
   *
   * Frames during a gesture carry only what was added since the last one. A
   * stroke grows without limit, so resending the whole of it twenty times a
   * second gets heavier the longer somebody draws — the cost landing exactly
   * where a long sweep most needs to keep up.
   *
   * The forced frame at the end sends the lot and says `replace`, which is what
   * makes the cheap ones safe: a dropped fragment leaves a gap, and rather than
   * every frame paying to repair a loss that usually has not happened, the end
   * of the gesture repairs all of them at once.
   */
  function broadcast (
    mark: { tool: string, composite?: string | null, params: StrokeParams, points: number[] } | null,
    force = false,
  ) {
    if (!surfaceId.value || !mark) return

    const now = performance.now()

    if (!force && now - last < EVERY) return

    // Nothing new to say. A stationary pointer still fires moves, and a frame
    // carrying no points is a socket write for nothing.
    if (!force && mark.points.length <= told) return

    last = now

    const points = force ? mark.points : mark.points.slice(told)

    told = mark.points.length

    // Heal records the colour it sampled for every dab it lays — up to five
    // thousand — and they exist only so an exact replay can put the same tones
    // back. A preview never reads them, and resending the list every frame is
    // tens of kilobytes of something nobody will look at. The row carries them.
    const { colours: _sampled, ...params } = mark.params

    sendLive(workspace.value, {
      kind: 'stroke',
      surfaceId: surfaceId.value,
      pageId: where.page.value ?? 0,
      key: where.key.value,
      clientId: clientId.value,
      seq: seq.value,
      tool: mark.tool,
      composite: mark.composite,
      params,
      points,
      ...(force ? { replace: true } : {}),
    })
  }

  /** The hand has lifted. Says so; does not ask anybody to rub anything out. */
  function end () {
    if (!surfaceId.value) return

    sendLive(workspace.value, {
      kind: 'stroke-end',
      surfaceId: surfaceId.value,
      clientId: clientId.value,
    })
  }

  function drop (from: string) {
    const { [from]: gone, ...rest } = drawing.value

    drawing.value = rest
  }

  /**
   * Take a drawing off once the real stroke is on the page.
   *
   * Matched on `(clientId, seq)` rather than on the client alone, which would
   * retire the *next* stroke from somebody who has already painted here the
   * instant it began — their earlier rows never leave the log.
   *
   * Called by the consumer as its log changes, and before it repaints: the
   * drawing has to come off in the same frame the row goes on, or there is one
   * showing both and one showing neither.
   */
  function retire (rows: { clientId: string, seq: number }[]) {
    const committed = new Set(rows.map((row) => `${row.clientId}:${row.seq}`))

    const stale = Object.entries(drawing.value)
      .filter(([, ghost]) => committed.has(`${ghost.clientId}:${ghost.seq}`))
      .map(([id]) => id)

    if (!stale.length) return

    drawing.value = Object.fromEntries(
      Object.entries(drawing.value).filter(([id]) => !stale.includes(id)),
    )
  }

  onSwarmLive((room, from, live) => {
    if (room !== workspace.value || live.kind === 'adjust') return

    // `stroke-end` names no page or key — it is only ever the tail of a gesture
    // already being drawn, so being told about it is proof enough that it was
    // accepted in the first place.
    if (live.kind === 'stroke' && !mine(live)) return
    if (live.kind === 'stroke-end' && !drawing.value[from]) return

    if (live.kind === 'stroke-end') {
      const held = drawing.value[from]

      if (!held) return

      /*
       * Kept, not dropped. The hand has lifted but the row it becomes is a
       * POST, a notice and a fetch away, and rubbing the drawing out now leaves
       * the page bare for that whole round trip — the stroke vanishing the
       * moment it is finished and reappearing a beat later.
       *
       * The timer is only for the stroke whose row never comes: a viewer, an
       * offline moment, a refused write. A drawing nothing will replace has to
       * go on its own eventually, or it is a mark no undo can reach and no
       * reload explains.
       */
      drawing.value = { ...drawing.value, [from]: { ...held, ending: true } }

      setTimeout(() => {
        if (drawing.value[from]?.ending) drop(from)
      }, ORPHANED)

      return
    }

    // Appended, because a frame carries only what is new — except the last,
    // which carries the whole stroke and says so.
    const held = live.replace ? undefined : drawing.value[from]

    drawing.value = {
      ...drawing.value,
      [from]: {
        tool: live.tool,
        composite: live.composite,
        params: live.params,
        clientId: live.clientId,
        seq: live.seq,
        points: held ? [...held.points, ...live.points] : live.points,
      },
    }
  })

  // Somebody leaving mid-stroke would otherwise leave their drawing on the page
  // for ever — there is no hand left to lift.
  watch(peers, (here) => {
    const present = new Set(here.map((peer) => peer.id))

    if (Object.keys(drawing.value).every((id) => present.has(id))) return

    drawing.value = Object.fromEntries(
      Object.entries(drawing.value).filter(([id]) => present.has(id)),
    )
  })

  return { drawing, seq, begin, broadcast, end, retire }
}
