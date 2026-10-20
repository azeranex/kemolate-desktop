/**
 * The local database — to come.
 *
 * In the web build this is the server's SQLite (drizzle over `node:sqlite`),
 * and the renderer imports a handful of its row *types* from here. The desktop
 * app keeps its data on this machine, in a database the main process will own,
 * at this same path. Until it exists, the types the renderer already names are
 * here, copied from the web build's `server/database/schema.ts` — exactly, so a
 * value shaped for one is shaped for the other.
 */

/** Whatever one tool needs remembering about one mark — see `strokes`. */
export interface StrokeParams {
  /** Radius in page pixels. */
  size?: number
  /** Edge softness, nought (crisp) to one (no edge at all). */
  softness?: number
  /** #rrggbb, for the tools that lay down a colour. */
  colour?: string
  /** Brush-to-source vector, fixed at the start of a clone stroke. */
  cloneOffset?: { x: number, y: number }
  /** The region a drag tool worked on, for patch and heal. */
  region?: { x: number, y: number, w: number, h: number }
  /**
   * What heal sampled, one `#rrggbb` per dab, recorded at paint time.
   *
   * Heal reads a ring-median off the page as it looks *now* — and "now" is the
   * one thing a replay cannot have. A concurrent stroke that orders under this
   * one changes what the ring would read, so a replayed heal would paint
   * different colours than the painter saw. Recording the samples turns the
   * stroke into "lay these colours along this path", which replays exactly,
   * whatever landed underneath it since.
   */
  colours?: string[]
  /**
   * Which automatic mask a correction was drawn against — `MASK_RECIPE`.
   *
   * Only on mask strokes, and one letter because it is written on every one of
   * them. The automatic half of a mask is recomputed rather than stored, so
   * changing the threshold or the dilation leaves every saved correction
   * sitting over a different base; the stamp is what lets an old one be
   * recognised individually rather than the whole lot being distrusted.
   *
   * Declared here because it is written here. The mask brush was building its
   * request body by hand and this key rode along untyped — which is exactly the
   * sort of thing that stops being true quietly.
   */
  m?: number
}

/** One mark on a surface — the `strokes` table's row (`typeof strokes.$inferSelect`). */
export interface Stroke {
  id: number
  surfaceId: number
  seq: number
  clientId: string
  authorId: number | null
  tool: 'brush' | 'eraser' | 'clone' | 'heal' | 'patch'
  composite: string | null
  params: StrokeParams
  points: number[]
  x: number
  y: number
  w: number
  h: number
  retracted: boolean
  createdAt: Date
}
