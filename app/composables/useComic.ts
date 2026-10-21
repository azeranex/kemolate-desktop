/**
 * The comic being worked on, which is only ever a real one.
 *
 * There was a stand-in here — eight invented pages with invented dialogue, so
 * the workspace could be looked at with something in it before anything could
 * be opened. It earned its keep while there was nothing else to see and stopped
 * the moment workspaces became things people share: somebody joining a
 * colleague's chapter was shown the invention and had no way to tell. An empty
 * workspace now says it is empty.
 *
 * Nothing is uploaded to open a page. A scan is held as the `File` the browser
 * was handed and an object URL onto it, both of which stay on this machine —
 * which is what makes the pages the user's own, and what lets a page be handed
 * to a peer directly rather than by way of a server.
 *
 * Coordinates are percentages of the page box rather than pixels, so the same
 * numbers place a block on a thumbnail an inch tall and on a page filling the
 * window. Nothing here knows how big it will be drawn.
 */
import type { EffectScope, ShallowRef } from 'vue'

// By hand, so a dev server already running picks up an export it has not seen.
import { isFreeModel, modelFamilyOf, successorOf } from '#shared/utils/models'
import { pickedName } from '~/utils/images'

/** What a block turned out to be, once someone or something had read it. */
export type BlockType = 'bubble' | 'caption' | 'sfx' | 'garbage'

/** A box on the page, in percentages: `x`/`y` from the top left. */
/**
 * Desktop: `PageBox` where the web build says `Box`, and `PageScan` below
 * where it says `Scan`. Each name is also a different type in `shared/utils`
 * (`ocr.ts`'s `Box` is a centre and an angle, `transform.ts`'s `Scan` only a
 * size), and the auto-imports can hold one meaning per name — they took the
 * shared ones, and warned about the tie on every start. Renamed on this side
 * so a bare name means one thing and nothing is left to warn about.
 */
export interface PageBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Block extends PageBox {
  id: string
  type: BlockType
  /**
   * How far the block is turned, in degrees clockwise about its own centre.
   *
   * Absent on almost every block, which is why it is optional rather than
   * nought: a page of upright balloons should carry no rotation at all, and a
   * sound effect running up a panel should carry the one number that says so.
   * The reading already knows this angle — see `angle` on a `BlockDraft`, which
   * the canvas used to drop on the floor for want of anywhere to put it.
   */
  angle?: number
  /** How far it leans, across and down, in degrees. Photoshop's skew. */
  skewX?: number
  skewY?: number
  /**
   * Its four corners, where they have been pulled away from the rectangle —
   * north-west first and clockwise, in the scan's own pixels. Photoshop's
   * distort, and the one part of a transform that no amount of turning, leaning
   * or scaling can say: a general quadrilateral is a projective map, not an
   * affine one. See `quadMatrix`.
   */
  quad?: number[]
  /** What was read off the page. */
  source: string
  /**
   * The blocks this one is made of, where somebody joined several into a
   * balloon — Illustrator's compound path, and the same bargain.
   *
   * Absent on an ordinary block, which is nearly all of them. A block that has
   * children *is* the balloon: it carries the kind, the translation and the
   * lettering, and the children carry only their own boxes and their own
   * `source`, which is the per-column reading that releasing gives back.
   *
   * They are held here rather than beside the list on purpose. `blocks` is the
   * one list, so every consumer — the canvas, the translator, the cleaner, the
   * panel — sees a balloon as a single thing without having to know balloons
   * exist. The shape that preceded this kept a separate grouping and a derived
   * view, and twelve call sites went on reading the raw list and quietly
   * treating one balloon as three.
   */
  children?: Block[]
  /** What will be lettered back onto it. */
  translation: string
  /** How sure the reader was, nought to a hundred. */
  confidence: number
  /** Kept out of the render, without being thrown away. */
  hidden: boolean
  /**
   * How the line is set, where it differs from the default — see `Lettering`.
   *
   * Absent rather than filled in, so a block that has never been touched carries
   * nothing, and changing what the default *is* changes every such block instead
   * of leaving a page full of copies of the old one. It is also what Reset does:
   * take the settings off, rather than write today's defaults down.
   */
  style?: Partial<Lettering>
  /**
   * Where the *translated* lettering sits, once it has been moved off the box it
   * was read from — see `letterBoxOf`, which is how everything asks for it.
   *
   * ## The concept, and what it is for
   *
   * A block's box was doing two contradictory jobs. It says **where the original
   * lettering was found**, which is a fact about the scan and the rectangle the
   * repair under it was cut from — `regionOf` and `patchKey` are both worked out
   * from it. It also said **how much room the translation gets**, which is a
   * typesetting decision and is not a fact about anything. English needs a wider
   * balloon than the Japanese it came from, so a letterer widens the box; the
   * key changes; the cleaned artwork that was made for the old rectangle is
   * orphaned and the page reverts to showing the printed line under the
   * translation. Nothing warned, because from the box's point of view nothing
   * had gone wrong: it had been asked to be two things and had picked one.
   *
   * So the typesetting half moved here. `letter` is in the same space as the
   * block's own `x`/`y`/`w`/`h` — percentages of the page box — and carries the
   * same optional turn, lean and pulled corners, because a lettering frame can be
   * transformed in every way a block can.
   *
   * **Absent is the ordinary case and means "on the block".** That is what every
   * page written before this concept existed says, so there is nothing to
   * migrate: with no `letter`, the lettering is set in the block's own box
   * exactly as it always was. It appears the first time somebody transforms a
   * block that has a translation, and Reset frame takes it away again.
   *
   * **Nothing in the cleaning path may ever read it.** `regionOf`, `patchKey`,
   * the mask and the patch store all go on reading the block's own box, and that
   * is the whole point: it is what makes a repair survive being re-lettered by
   * construction rather than by a rule somebody has to remember.
   */
  letter?: LetterBox
  /**
   * The room inside the balloon this block's lettering sits in, where the page
   * was read with a detector that draws balloons — see `blocks.room`.
   *
   * It is the frame a translation gets when nobody has placed one: `letterBoxOf`
   * reads `letter`, then this, then the block's own box — and this only once
   * there is a translation, so a block that has only been read stays exactly as
   * it was extracted. That order is the whole contract. A frame somebody dragged always wins; Reset frame takes `letter`
   * away and so lands back *here*, in the balloon, rather than in the narrow
   * shape of the original lettering; and a block with no balloon measured is
   * lettered exactly as before this existed.
   *
   * Upright, in page percentages like the box. Never written by a drag — a drag
   * writes `letter` — and, like `letter`, never read by the cleaning path.
   */
  room?: PageBox
}

/**
 * A lettering frame: the block's box shape exactly, and deliberately so.
 *
 * Structurally `Boxed` from `shared/utils/transform`, which is what the drag
 * arithmetic converts in and out of — named separately here only so that what a
 * `Block` carries reads as a thing rather than as a bag of four numbers. Keeping
 * it the same shape is what lets one `toOriented`/`toBoxed` pair serve both
 * boxes, so a transform cannot mean one thing on one and another on the other.
 */
export interface LetterBox extends PageBox {
  angle?: number
  skewX?: number
  skewY?: number
  quad?: number[]
}

/**
 * The box a block's words are set in: its lettering frame where somebody placed
 * one, the room inside its balloon where one was measured (`Block.room`) and
 * there is a translation to set in it, and its own box otherwise.
 *
 * The one derivation, for the reason everything else in this file is one: the
 * lettering plate draws it, `useLetteringFit` measures against it, the Lettering
 * panel reports it and the transform grips take hold of it, and four answers to
 * "which box" is four chances to be the odd one out.
 *
 * **A room waits for a translation.** It used to apply the moment it was
 * measured, and an untranslated block — whose plate shows the *source* as a
 * placeholder — then drew that placeholder out in the balloon while its hit
 * area and outline stayed on the reading, which is where a grip or a click on
 * an untranslated block lands (`framesLettering`). The box you could pick was
 * an empty rectangle, and the words beside it could not be picked at all. The
 * room is where a *translation* goes; what was read belongs where it was read.
 *
 * Note what is *not* on this list. The cleaning path asks for none of this — see
 * the note on `Block.letter`.
 */
export function letterBoxOf (block: Block): LetterBox {
  return block.letter ?? (block.room && block.translation ? { ...block.room } : blockBoxOf(block))
}

/**
 * A block's own box, as a frame — where the lettering was *found*.
 *
 * The zero turn, lean and corners are left off rather than written down, so this
 * round-trips through `toBoxed` unchanged and a block that has only ever been
 * moved carries no angle at all. See the note on `Block.angle`.
 */
export function blockBoxOf (block: Block): LetterBox {
  return {
    x: block.x,
    y: block.y,
    w: block.w,
    h: block.h,
    ...(block.angle ? { angle: block.angle } : {}),
    ...(block.skewX ? { skewX: block.skewX } : {}),
    ...(block.skewY ? { skewY: block.skewY } : {}),
    ...(block.quad ? { quad: block.quad } : {}),
  }
}

/**
 * Which of a block's two boxes the canvas is working on.
 *
 * The cost of splitting them: once a drag on a translated block moves the
 * lettering frame, the *detection* box can no longer be corrected by dragging —
 * and that box is what the repair is cut from, so it genuinely does need fixing
 * sometimes. A detector puts a balloon's box half a line too high often enough.
 * Leaving it unreachable would have traded a silent trap for a silent wall.
 *
 * The way out is a mode, chosen over the alternatives on these grounds:
 *
 * - **A modifier key** was the first idea and there are none left. A grip drag
 *   already spends Shift on proportional, Alt on from-centre, Cmd/Ctrl on
 *   distort and skew, and Alt+Shift+Cmd on perspective — see `onGrabMove`. A
 *   fifth meaning on a fourth combination is a thing nobody would find and
 *   everybody would hit by accident.
 * - **Only a reset action** — "put the lettering back on the block" — fixes the
 *   frame but never the reading: correcting a detection would mean resetting,
 *   dragging, and re-doing the typesetting from scratch. It is worth having and
 *   is not enough on its own, so it exists as well (`resetFrame`).
 * - **Two sets of grips on screen at once** is the most direct answer and was
 *   rejected on hit-testing: the two boxes are usually within a few pixels of
 *   each other, which is exactly when eight grips become sixteen overlapping
 *   ones and neither can be aimed at.
 *
 * What keeps a mode from being the trap modes usually are:
 *
 * - the canvas says which one is live, by drawing the *other* box as a faint
 *   dashed ghost beside the one under the grips. So it is legible while dragging
 *   rather than only in a panel, which may be shut.
 * - it is session state and not a stored preference. Reloading is a way out.
 * - `lettering` is the default and is what almost every act on a translated page
 *   means.
 */
export type Framing = 'lettering' | 'reading'

/**
 * Whether a transform on this block writes its lettering frame rather than its
 * own box.
 *
 * Two conditions, and each says something different. **A translation**, because
 * a block with nothing carried over yet has no typesetting to have opinions
 * about — positioning a detection is still a real act, and it is most of what
 * anybody does to a page that has only been read. **The framing**, because a
 * detection box on a translated block still has to be correctable.
 *
 * A block with no translation therefore behaves exactly as it did before any of
 * this existed, in either mode, which is most blocks on most pages.
 *
 * Pure and out here rather than inside the composable, because it is the whole
 * of the write-side rule: which box a drag lands on is the thing this concept
 * gets right or wrong, and it should be answerable without standing up a canvas.
 */
export function framesLettering (block: Block, framing: Framing): boolean {
  return framing === 'lettering' && Boolean(block.translation)
}

/** The box a transform takes hold of, which is the one the grips are drawn on. */
export function framedBoxOf (block: Block, framing: Framing): LetterBox {
  return framesLettering(block, framing) ? letterBoxOf(block) : blockBoxOf(block)
}

/**
 * Which plate a block's lettering lives on, and so which row of the stack
 * decides whether it is on the page and whether it is open to a tool.
 *
 * The one place the mapping is made. It is the join between a block — a thing
 * found on the page — and a layer, and a second copy of it somewhere else is how
 * one tool comes to think a block is reachable while another does not.
 */
export const plateOf = (block: Block): PlateId => (block.type === 'sfx' ? 'sfx' : 'dialogue')

/**
 * The image behind a page, when the page came off the user's machine.
 *
 * The `File` is kept alongside the URL rather than thrown away once one has
 * been made from it: the URL is only good for drawing, and everything else a
 * scan is for later — reading its pixels, sending it to a peer, writing it back
 * out — wants the bytes.
 */
/** Desktop: `Scan` in the web build — see `PageBox`. */
export interface PageScan {
  /** An object URL onto a local file. Making one uploads nothing. */
  url: string
  file: File
  /**
   * The image's own size, once something has drawn it — see `measure`. Nought
   * until then, and the page falls back to the usual proportions meanwhile.
   */
  width: number
  height: number
  /**
   * What the scan *is*, rather than what it is called — see `identify`. Null
   * until it has been worked out, which happens after the pages are on screen
   * and never before: this is the page's identity to everyone else, not to us,
   * and nothing on this machine is waiting on it.
   */
  hash: string | null
}

export interface ComicPage {
  id: string
  name: string
  /**
   * What the workspace calls this page, once it has been told about it.
   *
   * `id` is this browser's name for the page and is its path; `uid` is the
   * chapter's, and is the same in everybody's copy — see `pages.uid`. Absent
   * for a page in a workspace nobody has claimed, and until the first push
   * comes back.
   *
   * The two are not interchangeable and the difference is the point: a page
   * used to be matched to its row by content, which broke the moment a chapter
   * honestly held the same image twice — two blank pages have the same bytes,
   * and one row for two pages meant edits landing on the wrong one.
   */
  uid?: string
  blocks: Block[]
  /**
   * What this page is built out of — see `StackLayer`.
   *
   * On the page, beside its blocks, because that is what it is: the server has
   * said so since `layers.pageId` arrived, and the client had not caught up. It
   * held **one** stack in a `useState` and only ever swapped it in `pull`,
   * which returns immediately without a shared workspace — so every page of a
   * local chapter was looking at the same rows. A picture placed on page one
   * appeared on all three hundred, which is exactly the failure `DEFAULT_STACK`
   * describes and believed had been fixed.
   *
   * Keeping it here rather than in a map keyed by page id is what makes the
   * rest come out right for nothing: removing a page takes its stack, dragging
   * one carries the stack with it, and a page can no longer be looked up in a
   * map that has never heard of it.
   *
   * Optional for the reason `scan` is. A page can exist as a record before this
   * browser has founded it, and `layers` answers with the empty stack until
   * then rather than throwing.
   */
  stack?: StackLayer[]
  /**
   * The scan this page is, and absent for a page whose file is not on this
   * computer.
   *
   * That is a state the chapter is *shown in* rather than one it waits out. A
   * workspace holds the record of a chapter — its pages, their boxes, what they
   * say — and the scans stay on the machines that opened them, so a second
   * computer, a colleague, or the same browser after a folder was moved all
   * arrive at a chapter whose pages are entirely real and whose pictures are
   * not here. Those pages are drawn, ordered, read and translated like any
   * other; only the pixels are missing, and the reader is offered the file for
   * one by name. See `showMissing` in `useShared` for where they come from and
   * `link` in `useLibrary` for how a file is given to one.
   */
  scan?: PageScan
  /**
   * How big the page is, for a page with no scan to measure.
   *
   * The workspace recorded it when somebody who *did* hold the file drew it, so
   * a chapter whose scans are elsewhere still lays out in its own proportions
   * and the boxes on it land where they belong — block coordinates are shares
   * of the page box, and a share of the wrong shape is the wrong place. Read
   * through `pageSize`, which is what everything asks rather than reaching for
   * one of the two.
   */
  size?: { width: number, height: number }
  /**
   * Where the page sits in the chapter's folder, for a page whose id cannot
   * say.
   *
   * `id` carries the path for a page opened off a disk, which is why almost
   * nothing needs this. A page with no file has no path *here* — its id is its
   * uid — but the chapter still has one for it, and that is the path everybody
   * else matches their own folder against. Losing it would rewrite the row's
   * path to whatever the page happened to be called the moment a file was
   * linked to it. See `pathOfPage`.
   */
  path?: string
}

/** Whether the picture behind a page is on this computer — see `ComicPage.scan`. */
export const isOffline = (page: ComicPage) => !page.scan

/**
 * How big a page is, whichever of the two knows.
 *
 * The scan once something has drawn it, the workspace's own record otherwise,
 * and nought when neither has an answer yet — which callers already read as
 * "fall back to the usual page", so the shape of the answer is unchanged.
 */
export function pageSize (page: ComicPage): { width: number, height: number } {
  if (page.scan?.width && page.scan.height) return { width: page.scan.width, height: page.scan.height }

  return page.size?.width && page.size.height ? page.size : { width: 0, height: 0 }
}

/**
 * How big a page is, measuring its scan first where nothing has yet.
 *
 * `pageSize` answers with what is known, and for a page whose picture has not
 * been drawn and whose workspace recorded no size, that is nought — which the
 * box conversions read as "the usual 2:3 page". Harmless for drawing; ruinous
 * for anything that turns *stored* boxes into the canvas's percentages. The
 * boxes come out at the guessed shape, and the moment the real size lands
 * `useBlockSync` finds every one of them changed and sends them back converted
 * with it. Vertical position and height shrink by (2/3) / (width / height) each
 * time — ×0.9374 on a 2209×3106 page — and a chapter refreshed five times had
 * its third page lettered at 72% of the way down to where it belonged, with the
 * cleaning gone too, because every repair is filed under the box it was made
 * for. No page in any workspace had a recorded size, so every refresh did this
 * to whatever page was touched after it.
 *
 * So anything converting stored boxes asks here instead. A header read — the
 * one `openImages` makes for every page anyway, and `useClean` makes for the
 * same reason — settles the scan's size before a single box is built from it. A
 * page with no scan keeps the workspace's record, or nought where there is
 * none: nothing on this machine can measure it, and `useBlockSync` sends
 * nothing for a page without a scan size, so it cannot write a guess back.
 */
export async function sized (page: ComicPage): Promise<{ width: number, height: number }> {
  const scan = page.scan

  if (scan && !(scan.width && scan.height)) {
    const found = await imageDimensions(scan.file).catch(() => null)

    // Only where nothing measured it meanwhile: the decoded image is the last
    // word on its own size (see `measure`), and a header read that lands after
    // a draw must not overwrite it.
    if (found && !(scan.width && scan.height)) Object.assign(scan, found)
  }

  return pageSize(page)
}

/** What a workspace with nothing opened in it is called. */
export const UNTITLED = 'Untitled'

/** The usual page, and what a scan is drawn at until it says how tall it is. */
export const PAGE_RATIO = 2 / 3

/**
 * How far the page can be zoomed, as a multiple of the fit.
 *
 * One is the floor rather than something smaller: below the fit the page is
 * already whole, and shrinking it further only puts grey around a thing you can
 * see all of. Eight is where a scan has no more pixels to show.
 */
export const ZOOM_RANGE = { min: 1, max: 8 }

/** Keep a zoom inside the range, wherever it was worked out. */
export function clampZoom (value: number) {
  return Math.max(ZOOM_RANGE.min, Math.min(ZOOM_RANGE.max, value))
}

/** How long a change made in one jump takes to arrive. */
export const EASE_MS = 160

/**
 * The frame loop carrying an eased zoom, and where it is going.
 *
 * Module scope rather than state: there is one canvas and at most one glide,
 * and a frame id is nothing to render. `aim` is kept so that a second notch
 * arriving mid-glide compounds on where the page is *heading* rather than on
 * wherever the animation happens to be this frame — the same reason `glideTo`
 * in the canvas keeps a heading for the pan.
 */
let gliding = 0

/**
 * How long a frame is on this screen, as the glides have seen it — the step a
 * glide's first frame is given (see `glideView`). A 60 Hz guess until measured.
 */
let frameGap = 1000 / 60
let lastFrame = 0
let aim: { zoom: number, pan: { x: number, y: number } } | null = null

/**
 * The view — how far the page is zoomed and where it has been pushed to — held
 * for each app, and out of Nuxt's payload.
 *
 * ## Not a `useState`, though nearly everything around it is one
 *
 * These two are written on every frame of a pan, a zoom and a glide, and a
 * `useState` lives in the payload — which, in development, Nuxt DevTools watches
 * *deeply*: after any write it walks every page, every block and every point of
 * every mask correction the chapter holds. Measured on the test chapter, a frame
 * of a zoom cost 1.6 ms with the view in the payload and 1.0 ms out of it, a
 * frame of a pan 1.2 ms and 0.6. With sixty thousand numbers more in the
 * payload, standing in for a chapter's mask corrections, the zoom frame cost
 * 20.4 ms — more than a frame, on every frame — and 0.9 ms out of it: the walk
 * grows with the chapter, and the view no longer pays for it.
 * `useBrushCursor` tells the same story about the ring.
 *
 * ## Per app rather than per module
 *
 * The ring's position lives at module scope because only a pointer writes it
 * and the server has none. The view has writers that are not pointers — `reset`,
 * and `glideView`, which has a branch for the server — and on the server a
 * module is one module for every request it renders, so a view written there
 * would turn up in somebody else's page. Hung off the app instead: one in a
 * browser, one per request on the server, and nowhere DevTools looks. Nothing
 * carries it from the server to the browser, and nothing needs to: the server
 * has no room to fit a page into, so the only view it can render is the one the
 * browser starts from. The one thing a `useState` did better is survive
 * development's hot reload of this file, which now puts the view back to the fit.
 *
 * A `shallowRef` each, because every writer replaces the value whole — there is
 * nothing inside a zoom or a pan to watch.
 */
interface View {
  zoom: ShallowRef<number | null>
  pan: ShallowRef<{ x: number, y: number }>
}

const views = new WeakMap<object, View>()

/** The view of this app, made the first time it is asked for. */
function viewOf (app: object): View {
  let view = views.get(app)

  if (!view) {
    view = { zoom: shallowRef<number | null>(null), pan: shallowRef({ x: 0, y: 0 }) }
    views.set(app, view)
  }

  return view
}

/**
 * How hard the model is asked to think before it answers, lightest first.
 *
 * A list the type is derived from rather than a union written twice: the
 * settings are read back out of `localStorage` on the next visit and have to
 * be checked against something, and a second copy of these three words would
 * be a copy that could be added to without the checker hearing about it.
 */
export const EFFORT_ORDER = ['fast', 'balanced', 'thorough'] as const

export type Effort = typeof EFFORT_ORDER[number]

/**
 * The three ways a line can be got at, in order of how much they are given —
 * see the Translate panel, which is where they are explained and named.
 *
 * Here rather than there for the same reason as the efforts above: the panel
 * draws them, but what a stored setting is checked against belongs beside the
 * state it is stored from.
 */
export const TRANSLATE_ENGINES = ['google', 'ai-text', 'ai-image'] as const

export type TranslateEngine = typeof TRANSLATE_ENGINES[number]

/** How a line should be carried over, rather than what any one line says. */
export interface TranslateSettings {
  engine: TranslateEngine
  /** Which model, when the engine is one that has models. */
  model: string
  effort: Effort
  /*
   * Neither language is here any more.
   *
   * The source is not asked for at all: every engine works it out from the
   * text, so asking was asking the reader to repeat something already known,
   * with the standing risk of their getting it wrong and the machine obeying
   * them. The target moved to the workspace — see `useTargetLanguage` — because
   * it is a fact about the chapter rather than about how one person likes to
   * work, and everything left in here is the latter.
   */
  /*
   * The glossary is not here either, and for the same reason as the languages.
   *
   * There was a `glossary: number` in this shape, and it was a lie with a
   * plausible face: a count nobody wrote to, initialised to twenty-four, drawn
   * in the panel as "24 terms" and folded into the cost estimate as if it were
   * the size of a list. The real list belongs to the chapter and lives on the
   * server — see `useGlossary`.
   */
  honorifics: boolean
  /** Read the whole page for context before doing any line of it. */
  context: boolean
}

/**
 * The scope the selection's upkeep lives in — see `keepSelection`.
 *
 * Once for the tab, because it is about state there is one of. The two
 * watchers used to be made inside `useComic` itself, so every caller made two
 * more: one per page in the Pages strip, one per row in the Blocks and Layers
 * panels, and — worse — one pair for good from every call made inside a
 * callback or after an await, where nothing owns a watcher and nothing stops
 * it. `useShared`, `useClean`, `useLayerSync` and `useMaskEdits` all call it
 * that way, some of them on every collaborator's slider tick, so a long
 * session collected hundreds, each re-reading the stack and the page's blocks
 * on every page turn and every eye toggled.
 */
let upkeep: EffectScope | null = null

export function useComic () {
  // Every edit to a block is filed on the timeline as it is made — see `update`,
  // which is the one door they all come through.
  const { recordBlock, recordBlocks, recordGone, recordMade, forgetBlock } = useUndo()

  /**
   * Whether anything is open at all — and it starts as nothing.
   *
   * What was open last time lives in the browser's own storage, so the first
   * frame cannot know it. Nothing is a truer answer than a wrong something:
   * there used to be a stand-in comic here, eight invented pages shown while
   * the real answer was still being fetched, and it turned out to be the thing
   * people mistook for their colleague's chapter when they joined one.
   */
  const open = useState('comic-open', () => false)

  const pages = useState<ComicPage[]>('comic-pages', () => [])

  /**
   * Which comic this is, counted rather than named.
   *
   * Work that outlives the opening it started from — pages still coming out of
   * a PDF, hashes still being worked out — has to be able to tell that what it
   * is carrying still belongs here. A comic closed and another opened while a
   * book was still being read would otherwise take that book's remaining pages
   * into the wrong chapter. Whoever starts such work notes the number and
   * stops when it no longer matches.
   */
  const epoch = useState('comic-epoch', () => 0)

  /** What the open comic is called — the dropped folder, where there is one. */
  const title = useState('comic-title', () => UNTITLED)

  const at = useState('comic-page', () => 0)

  const page = computed(() => pages.value[at.value])

  /** The blocks selected, by id. Several, because the align tools need several. */
  const selection = useState<string[]>('comic-selection', () => [])

  /**
   * Where a Shift range is measured from — the last block picked outright, not
   * the last one a range happened to reach. It stays put while a range is being
   * widened or narrowed, so re-spanning starts from where you began rather than
   * creeping along behind the pointer.
   */
  const anchor = useState<string | null>('comic-anchor', () => null)

  const selected = computed(() => page.value?.blocks.filter((block) => selection.value.includes(block.id)) ?? [])

  /**
   * The one block the others are lined up *against*, where one has been named —
   * Illustrator's key object, named by the same gesture: with several picked,
   * clicking one of them again names it, and clicking it again takes the name
   * off. See `select`, which is where that press is read.
   *
   * An id rather than a list because there is at most one of them, and that is
   * the whole of what it is for: "align to" needs one answer, and a second key
   * would be a second answer to a question that has to have one.
   *
   * Held beside the selection rather than in the align panel, because it is
   * part of what is selected rather than a setting of the thing that reads it —
   * the canvas draws it heavier, the panel names it, and a block that leaves the
   * selection has to stop being the key whichever of them it left from. Kept in
   * the panel it would be a second copy pruned by only one of the two.
   */
  const keyed = useState<string | null>('comic-key', () => null)

  /**
   * The key as a block, and null unless it is still selected.
   *
   * Membership is checked here as well as pruned below, because the two answer
   * different frames: the watcher tidies the id up after a change, and this is
   * what keeps a reader honest during the one before it has run.
   */
  const keyBlock = computed(() => selected.value.find((block) => block.id === keyed.value) ?? null)

  /**
   * The block a caret is sitting in, by id, while somebody is typing into it.
   *
   * Shared rather than left inside the canvas editor that owns the caret, and
   * for one reason: an edit arriving from a collaborator replaces the blocks on
   * the page, and replacing the one being typed into takes the half-finished
   * sentence with it — the editor finds its block by looking this id up on every
   * keystroke, so a block swapped underneath it simply stops existing. `Board`
   * keeps it in step with its own `editing`; `useLiveSync` is what reads it.
   *
   * Null whenever nothing is being typed into, which is nearly always.
   */
  const writing = useState<string | null>('comic-writing', () => null)

  /**
   * How much of the page is shown, as a multiplier — fit is worked out on view —
   * and where the page has been pushed to, in pixels of the screen.
   *
   * Zooming moves the page as well as growing it — the point under the pointer
   * has to stay under the pointer — and both are one transform, so the offset
   * belongs beside the scale rather than to a scroll bar.
   *
   * The two pieces of state here that are not a `useState`: see `views`.
   */
  const { zoom, pan } = viewOf(useNuxtApp())

  /** How big the canvas is, written down by whoever is drawing it. */
  const room = useState('comic-room', () => ({ w: 0, h: 0 }))

  /**
   * Whether an eased glide is carrying the view right now — see `glideView`.
   *
   * Only ever raised for a change made in one jump — a key, a button, a notch
   * of a stepped wheel. A gliding wheel or a pinch is already a hundred small
   * changes a second, and easing each of them would set the page chasing the
   * pointer a fifth of a second behind, arriving somewhere else every time it
   * got close.
   *
   * It is also the glide's off switch: anything else that takes hold of the
   * page — a drag, a wheel — sets it false, and the frame loop reads that as
   * its cue to let go.
   */
  const eased = useState('comic-eased', () => false)

  /**
   * Carry the view to a new zoom and pan over `EASE_MS`, by writing the state
   * itself every frame.
   *
   * It used to be a CSS transition on the stage's transform, and the state
   * jumped. That was fine while the page was the only thing drawn from the
   * state — but the chrome (outlines, grips, labels) is drawn *outside* the
   * stage from the same numbers, so it arrived a fifth of a second before the
   * page and sat off its blocks for the whole glide. Animating the numbers
   * means everything drawn from them — stage and chrome alike — moves as one
   * thing, whatever it is.
   *
   * Interpolating pan and zoom along the same curve keeps the anchor point of
   * a zoom exactly pinned throughout: the pan that holds a point still is
   * linear in the zoom, so every blend of the two endpoints holds it still
   * too.
   *
   * `eased` is the running flag, and anything else that moves the page —
   * a drag, a wheel glide — already sets it false, which the loop reads as
   * "somebody else has the page" and lets go without writing another frame.
   */
  function glideView (toZoom: number, toPan: { x: number, y: number }) {
    if (!import.meta.client) {
      zoom.value = toZoom
      pan.value = toPan

      return
    }

    aim = { zoom: toZoom, pan: toPan }

    const z0 = zoom.value ?? 1
    const p0 = { ...pan.value }

    // Timed from the glide's own first frame, and that frame already one frame
    // in. `now` is when a frame *began*, so timing from the moment the glide
    // was asked for — partway through the frame before — made the first step
    // negative: ease-out at a negative time is further back, and six fast
    // notches in took the page from 1× down to 0.7× on the way to 2.5×.
    // Flooring that at nought instead left the first frame of every glide
    // standing still, one stalled frame per notch — a hiccup in the middle of
    // a zoom. Starting a frame's worth in, every frame moves.
    let began: number | null = null

    eased.value = true
    cancelAnimationFrame(gliding)

    const step = (now: number) => {
      if (!eased.value) {
        aim = null

        return
      }

      if (lastFrame && now > lastFrame && now - lastFrame < 50) frameGap = now - lastFrame
      lastFrame = now

      began ??= now - frameGap

      // Still floored, as the board's pan glide is: a frame stamped before the
      // one before it must not run the curve backwards.
      const t = Math.min(1, Math.max(0, (now - began) / EASE_MS))
      // Ease-out quint — the very curve the stage's transition used to wear,
      // `cubic-bezier(0.22, 1, 0.36, 1)`, as a function instead of a bezier.
      const s = 1 - (1 - t) ** 5

      zoom.value = z0 + (toZoom - z0) * s
      pan.value = { x: p0.x + (toPan.x - p0.x) * s, y: p0.y + (toPan.y - p0.y) * s }

      if (t < 1) {
        gliding = requestAnimationFrame(step)
      } else {
        aim = null
        eased.value = false
      }
    }

    gliding = requestAnimationFrame(step)
  }

  /**
   * Zoom about a point of the canvas, leaving whatever was under it there.
   *
   * `on` is measured from the canvas's own top left corner, which is also what
   * the page is scaled from — so a point on the page sits at `pan + offset ×
   * scale`, and the two lines below are that rearranged. Nothing is measured
   * and nothing is waited for, which is what lets it keep up with a wheel that
   * glides.
   */
  function zoomAt (factor: number, on?: { x: number, y: number }, glide = false) {
    // From where the page is *heading* when a glide is still in the air, so a
    // second notch compounds instead of restarting from mid-flight.
    const base = (eased.value && aim) || { zoom: zoom.value ?? 1, pan: pan.value }
    const from = base.zoom
    const to = clampZoom(from * factor)

    if (to === from) return

    const point = on ?? { x: room.value.w / 2, y: room.value.h / 2 }
    const landing = {
      x: point.x - ((point.x - base.pan.x) / from) * to,
      y: point.y - ((point.y - base.pan.y) / from) * to,
    }

    // Settle back onto a clean fit when zooming *out* lands near it. Only on
    // the way out: applied on the way in it would swallow the opening steps of
    // a pinch, which climbs through this range a fraction of a percent at a
    // time.
    if (to <= 1.02 && factor < 1) {
      resetView(glide)

      return
    }

    if (glide) {
      glideView(to, landing)
    } else {
      // A continuous change writes the numbers directly, and dropping the flag
      // is also what lets go of any glide still running — see `glideView`.
      eased.value = false
      zoom.value = to
      pan.value = landing
    }
  }

  /** Back to the whole page, squared up in the middle of the room. */
  function resetView (glide = true) {
    if (glide) {
      glideView(1, { x: 0, y: 0 })
    } else {
      eased.value = false
      zoom.value = 1
      pan.value = { x: 0, y: 0 }
    }
  }

  /**
   * The stack of whatever page is open — see `ComicPage.stack`, which is where
   * it actually lives.
   *
   * A view onto the page rather than a store of its own, and that is the fix
   * for "a picture placed on page one appears on all of them". This was a
   * `useState` holding a single stack, and the only thing that ever pointed it
   * at a different page was `useLayerSync.pull` — which returns immediately
   * without a shared workspace. So every page of a local chapter drew the same
   * rows, and every sheet, group, adjustment and placed image somebody added
   * was added to all of them at once. The server has held a stack per page
   * since `layers.pageId`; this is the client catching up.
   *
   * Writable, because `pull` assigns a whole stack when the server's copy
   * arrives and the reset below clears one. Both then land on the page they are
   * about instead of on a shared ref, which is what stops one page's rows being
   * saved against another.
   *
   * The empty stack is the answer before a page is founded — a workspace with
   * nothing open, and the moment a joined workspace knows what pages exist
   * without holding any of them. It is a `useState` of its own rather than a
   * fresh clone per read, because the panel would otherwise be handed a new
   * array on every render and could never keep a selection on it.
   */
  const noStack = useState<StackLayer[]>('comic-stack-none', () => structuredClone(DEFAULT_STACK))

  const layers = computed<StackLayer[]>({
    get: () => page.value?.stack ?? noStack.value,
    set: (next) => {
      if (page.value) page.value.stack = next
      else noStack.value = next
    },
  })

  /** Which row of the stack the opacity control at the top is talking about. */
  const layerSelection = useState<string | null>('comic-layer', () => 'dialogue')

  /**
   * The row being dragged, and where it would land — shared rather than held by
   * a row, because the rows are drawn by a component that draws itself again for
   * its children, so no one of them can see the others. The row that is picked
   * up and the row it is let go over are two different instances.
   */
  const layerDrag = useState<{
    id: string | null
    over: string | null
    where: 'before' | 'after' | 'inside' | null
  }>('comic-layer-drag', () => ({ id: null, over: null, where: null }))

  function endLayerDrag () {
    layerDrag.value = { id: null, over: null, where: null }
  }

  /**
   * A sweep of the eyes in progress, and what it is setting them to.
   *
   * Shared for the same reason the reorder drag is: the row where the sweep
   * began and the rows it passes over are separate instances of the same
   * component, and none of them can see the others. Null when nobody is
   * sweeping, which is also how a row knows to leave the pointer alone.
   */
  const eyeDrag = useState<{ to: boolean | null }>('comic-layer-eye', () => ({ to: null }))

  /**
   * Visibility is *set* rather than toggled, and this is the reason.
   *
   * A layer panel is expected to answer to a drag across its eyes: press on one,
   * pull down the column, and every row you cross joins the first one. Toggling
   * each row as it is crossed gives you the opposite — the rows that already
   * matched flip the wrong way, and a sweep meant to turn six rows off turns
   * three off and three on. So the first row decides the state and every row
   * after it is put into that state, which is idempotent and can be swept back
   * over without undoing itself.
   */
  function setLayerVisible (id: string, visible: boolean) {
    const row = findLayer(layers.value, id)

    if (row && row.visible !== visible) row.visible = visible
  }

  /** Start a sweep on one row's eye, which also flips that row. */
  function beginEyeDrag (id: string) {
    const row = findLayer(layers.value, id)

    if (!row) return

    eyeDrag.value = { to: !row.visible }
    setLayerVisible(id, !row.visible)
  }

  /** A row the sweep has reached. Does nothing when none is running. */
  function sweepEye (id: string) {
    const { to } = eyeDrag.value

    if (to !== null) setLayerVisible(id, to)
  }

  function endEyeDrag () {
    if (eyeDrag.value.to !== null) eyeDrag.value = { to: null }
  }

  /** Locking is set rather than toggled, for the same reason visibility is. */
  function setLayerLocked (id: string, locked: boolean) {
    const row = findLayer(layers.value, id)

    // The scan is nobody's to unlock — see `fixed` on the stack.
    if (row && !row.fixed) row.locked = locked
  }

  /** Whether a row is open to the tools, its own lock or an inherited one. */
  const editable = (id: string) => layerEditable(layers.value, id)

  /**
   * The stack flattened down to what the canvas has to draw, keyed by plate —
   * see `plateStates`. The canvas never walks the tree and never learns that a
   * group exists.
   */
  const plates = computed(() => plateStates(layers.value))

  /** The same plates in the order they paint, bottom of the pile first. */
  const pile = computed(() => paintOrder(layers.value))

  /** Which adjustments reach each plate — see `plateAdjusts`. */
  const adjusts = computed(() => plateAdjusts(layers.value))

  /** The sheets somebody has painted on, in the order they draw. */
  const sheets = computed(() => paintLayers(layers.value))

  /** And the pictures somebody has placed, in the order they draw. */
  const placed = computed(() => imageLayers(layers.value))

  /**
   * The row a mark would land on — see `inkedLayer`, which is where the rule
   * lives, because "may a tool touch this?" is a fact about the stack and not
   * about whichever tool is asking.
   */
  const inked = computed(() => inkedLayer(layers.value, layerSelection.value))

  /** The same question for the mask brush, which paints a mask and not paint. */
  const inkedMask = computed(() => inkedLayer(layers.value, layerSelection.value, 'mask'))

  /**
   * The plates open to the tools — see `openPlates`, which is where the rule
   * lives. Nothing below asks the stack anything itself; it asks this.
   */
  const reach = computed(() => openPlates(layers.value))

  /**
   * Whether a block is on the page at all, and whether it is there to be taken
   * hold of. Two questions rather than one, because they part company: a hidden
   * layer's blocks are not on the page, so their boxes go with them, while a
   * locked layer's are plainly there and simply not yours to move. Drawing a
   * locked block as absent would be lying about what the lock did.
   */
  const blockShown = (block: Block) => plates.value[plateOf(block)].visible

  const blockPickable = (block: Block) => reach.value.has(plateOf(block))

  /**
   * Every block a tool may act on, in page order — the one list a click, a
   * Shift range and a rubber-band all measure themselves against, so that the
   * three of them cannot disagree about what is there.
   */
  const pickable = computed(() => page.value?.blocks.filter(blockPickable) ?? [])

  const translate = useState<TranslateSettings>('comic-translate', () => ({
    engine: 'ai-text',
    // The id OpenRouter is called with, from `shared/utils/models`.
    model: DEFAULT_MODEL,
    effort: 'fast',
    honorifics: true,
    context: true,
  }))

  /**
   * Kept between sessions — see `remember`. The same settings `reset()` leaves
   * alone below, and for the same reason: they are how this reader likes to
   * work rather than anything about the chapter, so they should no more be
   * forgotten on a reload than on the way into another workspace.
   *
   * The model is checked against the curated list because that list moves —
   * providers retire ids — and a retired one would be sent to OpenRouter and
   * come back an error on the first page of the session. One the list replaced
   * moves to the entry that replaced it (`successorOf`), so a family moving on
   * keeps the reader on the rung they chose.
   *
   * There is nothing here about `glossary`, and there was: it used to be a
   * count in this object, written out with the rest and never read back. The
   * count is the chapter's rather than the reader's and now comes from
   * `useGlossary`, so there is no longer a field to make an exception for.
   */
  remember('kemolate:translate', translate, (held) => {
    const next: Partial<TranslateSettings> = {}

    if (TRANSLATE_ENGINES.includes(held.engine as TranslateEngine)) next.engine = held.engine as TranslateEngine
    // A retired id moves to its successor rather than to the first entry — see `successorOf`.
    const model = typeof held.model === 'string' ? successorOf(held.model) : null

    // Desktop: a free model is kept as chosen — the list does not name any; see `isFreeModel`.
    if (AI_MODELS.some((one) => one.id === model) || isFreeModel(model)) {
      next.model = model!
    } else {
      // Desktop: a version of a tracked family this list does not name — one a
      // refresh moved to last session — stays with its family's entry, which
      // the next refresh moves on again. See `AiModel.family`.
      const family = modelFamilyOf(model)
      const entry = family ? AI_MODELS.find((one) => one.family === family) : undefined

      if (entry) next.model = entry.id
    }
    if (EFFORT_ORDER.includes(held.effort as Effort)) next.effort = held.effort as Effort
    if (typeof held.honorifics === 'boolean') next.honorifics = held.honorifics
    if (typeof held.context === 'boolean') next.context = held.context

    return next
  })

  /**
   * Put the editor back to nothing at all.
   *
   * Not something a reader ever asks for — there is no button — and the one
   * caller is `useWorkspaceReset`, which fires it on the way into a workspace
   * this state is not about. It lives here because the state does: a list of
   * what has to be let go of, kept anywhere other than beside what holds it,
   * is a list that gains an entry it never hears about.
   *
   * `epoch` is bumped last and is the half that reaches work already in the
   * air. A book still being read, a chapter still being hashed and a page still
   * being recognised all check it and stop when it moves — otherwise the
   * remainder of the last workspace's PDF pours into this one.
   *
   * Two things are deliberately left alone. `room` is the size of the canvas,
   * which is a fact about the window rather than about any comic; and
   * `translate` is how this reader likes to work, which is the one thing in
   * here that is theirs rather than the chapter's.
   */
  function reset () {
    // Before the list goes, for the reason `openImages` gives: an object URL is
    // a claim on a file that outlives everything but the document.
    for (const old of pages.value) if (old.scan) URL.revokeObjectURL(old.scan.url)

    pages.value = []
    title.value = UNTITLED
    open.value = false
    at.value = 0

    selection.value = []
    anchor.value = null
    writing.value = null

    // The pages are already gone, and every stack went with the page it was on
    // — this is the one that belongs to no page.
    noStack.value = structuredClone(DEFAULT_STACK)
    layerSelection.value = 'dialogue'
    endLayerDrag()
    endEyeDrag()

    // Not `resetView`, which settles on the fit: null is "nobody has worked the
    // fit out yet", which is the honest answer before there is a page to fit.
    eased.value = false
    zoom.value = null
    pan.value = { x: 0, y: 0 }

    epoch.value++
  }

  /**
   * Open images from this machine as the comic, replacing whatever was open.
   *
   * The pages come in with no blocks, which is honest: a scan is a picture
   * until something has read it, and drawing boxes over a real page would be
   * claiming to have found something. They fill in as the work is done.
   *
   * The URLs of whatever was open are let go of here — an object URL is a claim
   * on the file behind it that lasts until the document does, so a session
   * spent opening one chapter after another holds every one of them otherwise.
   * The only other places that can are `removePage`, which loses one, and
   * `reset`, which loses the lot.
   */
  /**
   * The page as Vue holds it, found from the object it was built as.
   *
   * `openImages` and `appendImages` build their pages as plain objects, hand
   * them to `pages`, and then measure them in the background — and a write to
   * the plain object is a write Vue never hears. It used to land there: the
   * size was on the page, but anything that had already read it (the board's
   * `dims`, and through it every lettering style) kept the nought it read, so a
   * page turned to before its header was read was lettered in the interface
   * font until something else redrew it. Null for a page no longer open, which
   * is the check the old `includes` made.
   */
  function held (page: ComicPage): ComicPage | undefined {
    const raw = toRaw(page)

    return pages.value.find((candidate) => toRaw(candidate) === raw)
  }

  /**
   * `startAt` is the page to open on, by id — the one this browser was last on
   * (`usePagePosition`), where the caller knows it. Opening on page one and
   * turning to it a moment later was a wasted decode of page one on every
   * reload, and it was worse than wasted: page one's image loaded late onto the
   * page that replaced it and gave that page page one's size, and a chapter
   * whose pages differ in size had its lettering saved out of place.
   */
  async function openImages (images: PickedImage[], called?: string, startAt?: string) {
    if (!images.length) return

    for (const old of pages.value) if (old.scan) URL.revokeObjectURL(old.scan.url)

    const opened: ComicPage[] = images.map((image) => ({
      id: `scan:${image.path}`,
      // The file, not the path: the path is for ordering, and a name with the
      // folder still on it does not fit anywhere it is shown.
      name: pickedName(image),
      blocks: [],
      stack: structuredClone(DEFAULT_STACK),
      scan: { url: URL.createObjectURL(image.file), file: image.file, width: 0, height: 0, hash: null },
    }))

    const start = Math.max(0, opened.findIndex((page) => page.id === startAt))

    // The size of the page opened on, before anything renders. Read off the
    // file's header — a few kilobytes, no decode — because the alternative is
    // the canvas guessing 2:3 for a frame and snapping to the real shape when
    // the image lands, which reads as the page starting small and then fitting.
    // One await, milliseconds, and the first paint is the right shape.
    const first = opened[start]!.scan!

    const size = await imageDimensions(first.file).catch(() => null)

    if (size) Object.assign(first, size)

    pages.value = opened

    // What it is called comes from whoever opened it — a folder knows its own
    // name, and a handful of loose files has none to give.
    title.value = called
      ?? (images.length === 1 ? pickedName(images[0]!) : `${images.length} pages`)

    at.value = start
    selection.value = []
    open.value = true
    epoch.value++

    // And the rest, behind the paint: page two's shape should be known before
    // anybody turns to it. Sequential rather than parallel on purpose — two
    // hundred header reads are quick, and racing them buys nothing but a burst
    // of file handles.
    const rest = async () => {
      // Every page, the one opened on included: its size is already in hand,
      // and the check below is what skips it.
      for (const page of opened) {
        const scan = page.scan

        if (!scan || scan.width) continue

        const found = await imageDimensions(scan.file).catch(() => null)

        // Still the same open comic, and nothing measured it first — written
        // through the page Vue holds, see `held`.
        const live = held(page)?.scan

        if (found && live && !live.width) Object.assign(live, found)
      }
    }

    // Not awaited: the pages are on screen and nothing is waiting on this.
    rest()
  }

  /**
   * Add pages to the comic already open — the rest of a book, arriving while
   * its first page is being looked at.
   *
   * Slotted in among what is there rather than stuck on the end, because a
   * page that arrives late is still page nine and belongs where its path says.
   * The page being read is then found again by id, so pages filling in above
   * it do not shuffle the canvas out from under whoever is reading — the whole
   * point of showing page one early is that it stays looked-at.
   *
   * Pages already here are left alone: the same book opened twice is a
   * person's prerogative and not a reason to hold it twice.
   *
   * `asserted` is the difference between the two callers, and it decides what
   * the workspace makes of these pages rather than anything on this screen. The
   * rest of a book still being read is *this chapter arriving* and has to be
   * allowed to match the rows the chapter already has — a PDF opened twice on
   * two machines is one chapter, matched by its bytes. A page dropped in by
   * hand is a page in its own right, so it names itself here and the server
   * files it under that name instead of hunting for a row with the same
   * picture. See `rowFor` in `services/pages.ts`, which is where the rule is
   * stated, and `link` in `useLibrary` for the gesture that *does* mean "this
   * file is that page".
   */
  function appendImages (images: PickedImage[], asserted = false) {
    if (!images.length || !open.value) return

    const here = new Set(pages.value.map((page) => page.id))

    const fresh: ComicPage[] = images
      .filter((image) => !here.has(`scan:${image.path}`))
      .map((image) => ({
        id: `scan:${image.path}`,
        name: pickedName(image),
        ...(asserted ? { uid: crypto.randomUUID() } : {}),
        blocks: [],
        stack: structuredClone(DEFAULT_STACK),
        scan: { url: URL.createObjectURL(image.file), file: image.file, width: 0, height: 0, hash: null },
      }))

    if (!fresh.length) return

    const reading = pages.value[at.value]?.id

    pages.value = [...pages.value, ...fresh].sort((a, b) => comparePaths(a.id, b.id))

    const still = pages.value.findIndex((page) => page.id === reading)

    if (still !== -1) at.value = still

    // Their shapes, behind the paint, the same way `openImages` does it — a
    // page whose size is known before it is turned to does not jump when it is.
    const sized = async () => {
      for (const page of fresh) {
        const found = await imageDimensions(page.scan!.file).catch(() => null)
        const live = held(page)?.scan

        if (found && live && !live.width) Object.assign(live, found)
      }
    }

    sized()
  }

  /**
   * Put a blank white page in after the one being looked at, and turn to it.
   *
   * The shape of the page it follows, so a chapter keeps its proportions —
   * falling back to the usual page when that shape is not yet known.
   *
   * Its path — and so its id — is the current page's with a suffix on it,
   * which is what holds it in place everywhere order is worked out from
   * paths: a book still arriving behind it (see `appendImages`), a chapter
   * read back from the browser's own storage tomorrow. A name of its own
   * would sort it to wherever that name happened to fall.
   *
   * Returns what was made rather than keeping it, because keeping is not this
   * file's business — see `useLibrary`, which knows where this chapter lives.
   */
  async function addBlankPage (): Promise<PickedImage | null> {
    const here = page.value

    if (!here || !import.meta.client) return null

    const from = here.id.startsWith('scan:') ? here.id.slice('scan:'.length) : here.name

    /*
     * Numbered against the page a blank *follows*, never against a blank.
     *
     * Adding a blank turns to it, so the next add stands on a blank — and a
     * blank taken as the base finds none of its own children and calls itself
     * `blank-1` again, under a path a suffix longer:
     * `1.jpg.blank-1.png.blank-1.png`. Those two stayed distinct only by that
     * nesting, and the name grew with every page added. Stripping the suffix
     * puts every blank of one page in the same family, where they can be
     * counted.
     *
     * The shape itself is load-bearing and stays: `<base>.blank-<n>.png` sorts
     * immediately after the page it belongs to, which is the whole reason a
     * blank stays put among pages still arriving — see `inReadingOrder`.
     */
    const base = from.replace(/\.blank-\d+\.png$/i, '')
    const prefix = `scan:${base}.blank-`

    // The highest taken, not how many there are: deleting the first of two
    // blanks would otherwise hand the next one a number already on the chapter.
    const highest = pages.value.reduce((most, other) => {
      if (!other.id.startsWith(prefix)) return most

      const n = Number.parseInt(other.id.slice(prefix.length), 10)

      return Number.isNaN(n) ? most : Math.max(most, n)
    }, 0)

    const path = `${base}.blank-${highest + 1}.png`

    const width = here.scan?.width || 1600
    const height = here.scan?.height || Math.round(1600 / PAGE_RATIO)

    const image = await blankImage(path, width, height)

    if (!image) return null

    /*
     * Hashed before the page joins the chapter, not after.
     *
     * Every await between inserting a page and telling the workspace about it
     * is a window in which the watchers run, and `align` running in that window
     * finds a page the workspace has never heard of: it counts it a stranger,
     * says "1 of 2 pages match this workspace", and sorts the page just added
     * to the end. Hashing here rather than in `useLibrary.addBlank` closes the
     * window — by the time this returns, the page is complete and the push that
     * follows carries everything about it in one go.
     *
     * Null if it will not compute, which is survivable: `fill` exists for
     * exactly that and the page is on the chapter either way.
     */
    const hash = await hashFile(image.file).catch(() => null)

    pages.value.splice(at.value + 1, 0, {
      id: `scan:${path}`,
      name: pickedName(image),
      /*
       * No uid minted here, unlike a page dropped in — see `appendImages`.
       *
       * A blank is the one page that used to be unrecognisable: every blank of
       * a size was the same PNG, so its hash named all of them and none of
       * them, and naming it on the spot looked like the fix. It is not the fix
       * this codebase took. `blankImage` writes the page's own path into an
       * `iTXt` chunk, so two blanks genuinely differ and the digest stays a
       * true content hash — which is what keeps a peer's re-hash on arrival
       * meaningful, and what a uid minted here would quietly route around.
       *
       * So a blank is recognised like any other page, and the assertion that a
       * drop makes is reserved for the gesture that actually means it.
       */
      blocks: [],
      stack: structuredClone(DEFAULT_STACK),
      scan: { url: URL.createObjectURL(image.file), file: image.file, width, height, hash },
    })

    go(at.value + 1)

    return image
  }

  /**
   * Put a page at `to` in the reading order, where `to` is a gap between
   * thumbnails rather than a thumbnail: nought is before the first, and the
   * length is after the last. The same arithmetic as `moveBlock`, for the same
   * reason — lifting the page out closes the gap it left.
   *
   * The page being looked at is followed to wherever it lands, so reordering
   * the chapter never turns the canvas to somewhere else.
   */
  /**
   * Take a page out of the open chapter.
   *
   * The object URL goes with it — it is a handle onto a file this browser is
   * holding open, and a chapter closed a page at a time without revoking them
   * keeps every scan in memory until the tab does.
   *
   * `at` is nudged rather than left: it is an index, so removing a page ahead of
   * the one being read slides a different page under it, and removing the last
   * page leaves it pointing past the end. Both look like the chapter jumped.
   * Staying on the same page where it survives, and on whatever took its place
   * where it did not, is what somebody deleting from the strip expects.
   */
  function removePage (id: string) {
    const gone = pages.value.findIndex((candidate) => candidate.id === id)

    if (gone === -1) return

    const looking = page.value?.id
    const [removed] = pages.value.splice(gone, 1)

    if (removed?.scan) URL.revokeObjectURL(removed.scan.url)

    selection.value = []

    const still = pages.value.findIndex((candidate) => candidate.id === looking)

    // The page being read is still open somewhere: follow it. Otherwise it was
    // the one removed, so stay at the same place in the list and let the next
    // page take its turn — clamped, because the last page has no next.
    at.value = still !== -1 ? still : Math.max(0, Math.min(gone, pages.value.length - 1))

    /**
     * The last page out closes the comic, because a comic with no pages in it
     * is not one.
     *
     * `open` is its own flag rather than `pages.length > 0` — see the note on
     * it — and nothing here used to put it back down, so removing every page
     * left a chapter that was still officially open with nothing in it. What
     * that looked like was worse than it sounds: every empty state on this
     * page hangs off `!open`, so none of them drew, and the canvas rendered a
     * chapter whose current page was `undefined`. A blank screen with no
     * message and no way back, which reads as the app having broken rather
     * than as a chapter you have just emptied.
     *
     * Down here rather than in the panel that does the deleting, because it is
     * a fact about the comic and not about the button: a page removed by a
     * collaborator (see `useLiveSync.relist`) empties a chapter exactly as
     * thoroughly as one removed by hand.
     */
    if (!pages.value.length) open.value = false
  }

  function movePage (id: string, to: number) {
    const from = pages.value.findIndex((candidate) => candidate.id === id)

    if (from === -1) return

    const looking = page.value?.id
    const [moved] = pages.value.splice(from, 1)

    if (moved) pages.value.splice(Math.max(0, Math.min(from < to ? to - 1 : to, pages.value.length)), 0, moved)

    const still = pages.value.findIndex((candidate) => candidate.id === looking)

    if (still !== -1) at.value = still
  }

  /**
   * What a page is called, changed. Only what it is *called*: the scan keeps
   * its own file name and its id, so nothing filed under either — hashes,
   * blocks, the copy in storage — moves an inch.
   */
  function renamePage (id: string, name: string) {
    const target = pages.value.find((candidate) => candidate.id === id)
    const called = name.trim()

    if (target && called) target.name = called
  }

  /**
   * Record how big a scan turned out to be, where nothing has said yet.
   *
   * The header sniff in `openImages` usually gets there first — see
   * `imageDimensions` — and this is the fallback for the formats it cannot read.
   *
   * It fills a size in and never changes one, and that is load-bearing. A size
   * is what a page's boxes and frames are converted in and out of storage at,
   * so a size that changes after a page's reading has arrived is a reading read
   * at one size and saved at another: every box and frame on the page moves by
   * the ratio of the two, on the server, for good. It happened — a late image
   * load gave page eleven page one's size, the true size landed a moment
   * later, and every lettering frame on it was saved 7% lower than it was.
   * The header is the size the whole app uses in any case (`sized`, the
   * restore, the page sync), so a decode disagreeing with it — a JPEG turned by
   * its EXIF — is kept consistent rather than corrected halfway through.
   */
  function measure (id: string, width: number, height: number) {
    const scan = pages.value.find((candidate) => candidate.id === id)?.scan

    if (scan && !(scan.width && scan.height)) Object.assign(scan, { width, height })
  }

  /**
   * Record what a scan turned out to be — see `hashFile`.
   *
   * By page id rather than by index, because this arrives long after it was
   * asked for and the pages may well have been replaced in the meantime. A hash
   * landing on whatever is now in slot four would be worse than no hash at all.
   */
  function identified (id: string, hash: string) {
    const scan = pages.value.find((candidate) => candidate.id === id)?.scan

    if (scan) scan.hash = hash
  }

  /**
   * Give a page whose picture was not on this computer the file it is.
   *
   * The page is not replaced and its id does not move: everything the chapter
   * has already accumulated for it — its blocks, its translations, whatever the
   * workspace has filed under its row — belongs to *this* page, and swapping in
   * a new object would be adding a second page that merely looked like it. That
   * is the whole difference between re-linking and dropping, and it is the
   * reason this exists rather than a call to `appendImages`.
   *
   * The hash comes in already worked out. Whoever asked for this had to know it
   * before deciding the file was the right one — a fetch from a peer checked it
   * against what it asked for, and a file chosen by hand was weighed against
   * what the workspace recorded — so re-reading the bytes here would be reading
   * a chapter's worth of files twice to learn what the caller already knew.
   *
   * Refuses a page that already has one. Overwriting a scan would leak the
   * object URL it was holding and quietly change what everything filed under
   * the old hash was about; replacing a page's file is a different act and does
   * not exist yet.
   */
  function attach (id: string, file: File, hash: string | null) {
    const target = pages.value.find((candidate) => candidate.id === id)

    if (!target || target.scan) return false

    target.scan = {
      url: URL.createObjectURL(file),
      file,
      // The workspace's own record of the shape, where it has one, so the page
      // does not jump from the proportions it was being drawn at to its real
      // ones the instant the picture lands. `measure` corrects it either way.
      width: target.size?.width ?? 0,
      height: target.size?.height ?? 0,
      hash,
    }

    return true
  }

  function go (to: number) {
    if (to < 0 || to >= pages.value.length) return

    at.value = to
    // A selection is a selection of *this* page's blocks; carrying the ids over
    // would select whatever happened to share them on the next one. The anchor
    // goes with it — a range spanning from a block on the page before is a range
    // spanning from nowhere.
    setSelection([], null)
  }

  /**
   * Set the selection outright, and say where a later range should span from.
   *
   * Held to what is within reach here rather than at each place that selects.
   * The canvas, the block list and whatever selects next are all one call away
   * from picking something on a layer the reader switched off, and a check
   * repeated at three doors is a check missing from the fourth.
   */
  function setSelection (ids: string[], at?: string | null) {
    const left = new Set(pickable.value.map((block) => block.id))

    selection.value = [...new Set(ids)].filter((id) => left.has(id))

    if (at !== undefined) anchor.value = at
  }

  /**
   * Pick a block: `add` takes or drops the one, `range` takes everything between
   * the anchor and this one, and a plain click starts over. `null` is the press
   * that means nothing.
   *
   * **A range is a list gesture, and only the lists ask for one.** The rows
   * beside the page are in an order the reader can see, so "everything between
   * these two" names a run they are looking at. The page is not: the blocks are
   * scattered over the art, and spanning the list's order from a click on the
   * canvas lights up balloons somewhere else entirely — nothing about where the
   * pointer went picked them. So `Board.vue` reads Shift as `add`, the way the
   * rubber band already did, and passes `range` from nowhere. Decided by the
   * caller rather than here because it is a fact about the surface pressed, not
   * about the selection, which is one thing across both.
   *
   * A range spans `pickable` rather than the page's own blocks, so a range drawn
   * across a locked layer steps over it instead of quietly gathering up rows
   * that would then refuse everything asked of them.
   *
   * The one press that does not select anything is a plain click *inside* a
   * selection of several: that names the key object — see `keyed`, and the note
   * on the branch below, which is where the cost of it is argued.
   */
  function select (id: string | null, how: { add?: boolean, range?: boolean } = {}) {
    if (!id) return setSelection([], null)

    // Out of reach is out of reach however it was reached for — from the page,
    // from the list beside it, or from a keyboard.
    if (!pickable.value.some((block) => block.id === id)) return

    if (how.range && anchor.value) {
      const keys = pickable.value.map((block) => block.id)
      const from = keys.indexOf(anchor.value)
      const to = keys.indexOf(id)

      // With nothing anchored on the list there is no range to take, so this
      // falls through to adding the one block — which is what the reader was
      // reaching for anyway.
      if (from !== -1 && to !== -1) {
        const [a, b] = from < to ? [from, to] : [to, from]

        return setSelection(keys.slice(a, b + 1))
      }
    }

    if (how.add) {
      selection.value = selection.value.includes(id)
        ? selection.value.filter((other) => other !== id)
        : [...selection.value, id]
      anchor.value = id

      return
    }

    /**
     * Clicking again inside a selection of several names the key object rather
     * than starting over, and clicking the key names nothing — Illustrator's
     * gesture, and the only way there is to say *which* block the rest should
     * line up on. Nothing is selected or dropped by it, so the anchor stays
     * where a range would still span from.
     *
     * It costs the click that used to narrow a selection down to the block
     * under the pointer. That is a real cost and it is the trade Illustrator
     * makes too: the page, or Escape, is the way back to starting over, and one
     * press of it is a click and a click rather than a click.
     *
     * Here rather than in the canvas because the list beside the page and the
     * page are one selection. A press that named a key on the page and threw
     * one away in the list is the two surfaces going out of step, which is the
     * thing this file exists to prevent.
     */
    if (!how.add && !how.range && selection.value.length > 1 && selection.value.includes(id)) {
      keyed.value = keyed.value === id ? null : id

      return
    }

    setSelection([id], id)
  }

  /**
   * Everything the tools can reach, across every layer at once — which is the
   * whole of what "except hidden and locked" comes to: the stack decides what is
   * in the list, and Select All takes the list.
   */
  function selectAll () {
    const keys = pickable.value.map((block) => block.id)

    setSelection(keys, keys[keys.length - 1] ?? null)
  }

  /**
   * Every block whose *centre* falls inside a rubber-band, in page percentages.
   *
   * By centre rather than by overlap: blocks on a comic page routinely sit over
   * one another, and catching one because a corner of it grazed the rectangle is
   * exactly the surprise this replaces. A band drawn down a column of balloons
   * should take that column, not the one beside it that leans in.
   *
   * The framed box rather than the block's own, so a band catches the balloons
   * where they are being drawn and dragged — see `framedBox`. Sweeping past a
   * lettering frame and picking nothing, because the reading it was cut from is
   * still up the page where the detector left it, is the same class of surprise.
   */
  function selectWithin (band: PageBox, add = false) {
    const keys = pickable.value
      .filter((block) => {
        const box = framedBox(block)
        const cx = box.x + box.w / 2
        const cy = box.y + box.h / 2

        return cx >= band.x && cx <= band.x + band.w && cy >= band.y && cy <= band.y + band.h
      })
      .map((block) => block.id)

    setSelection(add ? [...selection.value, ...keys] : keys, keys[keys.length - 1] ?? anchor.value)
  }

  /**
   * Put a block at `to` in the reading order, where `to` is a gap between rows
   * rather than a row: nought is above the first, and the length is below the
   * last.
   *
   * Taken out and put back in one step, because lifting it out closes the gap
   * it left — so every gap below it, including the one being aimed at, has
   * already moved up by one by the time we come to use it.
   */
  function moveBlock (id: string, to: number) {
    const list = page.value?.blocks
    const from = list?.findIndex((block) => block.id === id) ?? -1

    if (!list || from === -1) return

    const [block] = list.splice(from, 1)

    if (block) list.splice(Math.max(0, Math.min(from < to ? to - 1 : to, list.length)), 0, block)
  }

  /**
   * Move a row of the layer stack against another one — see `dropLayer`, which
   * is where the rules about what may go where live, because the panel is not
   * the only thing that will ever move a row.
   */
  function moveLayer (id: string, targetId: string, where: 'before' | 'after' | 'inside') {
    dropLayer(layers.value, id, targetId, where)
  }

  /* ---------- lettering ---------- */

  /**
   * Which box the canvas is transforming — see `Framing`, which is where the
   * choice is argued.
   *
   * `useState` rather than a stored setting on purpose: a mode you can be stuck
   * in without knowing is the thing modes are rightly distrusted for, and a
   * reload should be a way out of this one.
   */
  const framing = useState<Framing>('block-framing', () => 'lettering')

  // The rule itself is `framesLettering`, above and pure. These two are it with
  // the current mode already in hand, which is what every caller wants.
  const writesLetter = (block: Block) => framesLettering(block, framing.value)
  const framedBox = (block: Block) => framedBoxOf(block, framing.value)

  /**
   * Put the lettering back on the block it was read from.
   *
   * The other half of the mode above, and the one that is a *decision* rather
   * than a way of working: it says this frame was a mistake, rather than that
   * the next drag should land somewhere else. Through `updateMany` so it is one step
   * on the timeline, and by writing `undefined` rather than a copy of the block's
   * box — "no frame of its own" is a different claim from "a frame that happens
   * to match today", and only the first of them follows the block if the
   * detection is corrected afterwards.
   */
  function resetFrame () {
    updateMany(selected.value.filter((block) => block.letter).map((block) => ({ id: block.id, patch: { letter: undefined } })))
  }

  /**
   * How one block is set, its own settings over the defaults.
   *
   * `vertical` is left as it was written, null and all — the panel has to be
   * able to tell "as it reads" from a direction somebody chose. What that null
   * resolves to is `setDown`, which everything that draws or measures asks
   * instead.
   */
  const styleOf = (block: Block) => letteringOf(block.style, block.type)

  /**
   * A block's balloon in the scan's own pixels, which is what orientation and
   * every size here are measured in. Null before the file has been looked at.
   *
   * The *lettering* frame, not the block's box, and that is the whole of what a
   * balloon means here: every caller of this is asking how much room the words
   * have — which way they should run, what size fits — and once a letterer has
   * given the translation a frame of its own, the room the words have is that
   * frame. Asking the block's box would size English to the Japanese it replaced.
   */
  function balloonOf (block: Block) {
    const scan = page.value?.scan
    const box = letterBoxOf(block)

    return scan?.width && scan.height
      ? { w: (box.w / 100) * scan.width, h: (box.h / 100) * scan.height }
      : null
  }

  /**
   * Which way a block is actually set — see `verticalOf` for the rule.
   *
   * Asked here rather than worked out by each caller, for the reason everything
   * else in this file is: the canvas draws it, the fit measures against it and
   * the panel reports it, and three answers to one question is three chances to
   * be the odd one out.
   */
  function setDown (block: Block): boolean {
    const style = styleOf(block)

    if (style.vertical !== null) return style.vertical

    const box = balloonOf(block)

    return box ? verticalOf(style, block, box) : false
  }

  /**
   * How the selection is set — one style, with a note of which of its parts the
   * blocks disagree about.
   *
   * A panel editing several blocks has to say *mixed* rather than pick one of
   * them and show it as though it were the answer: a slider sitting at the first
   * block's size reads as "they are all this", and nudging it would then be the
   * only way to find out they were not.
   */
  const lettering = computed(() => {
    const styles = selected.value.map(styleOf)
    const value = styles[0] ?? LETTERING
    const mixed = new Set<keyof Lettering>()

    for (const key of Object.keys(LETTERING) as (keyof Lettering)[]) {
      if (styles.some((style) => style[key] !== value[key])) mixed.add(key)
    }

    return { value, mixed }
  })

  /**
   * Set part of the lettering on everything selected.
   *
   * Written over each block's own settings rather than over the resolved style,
   * so a block that never had a size still has none afterwards — turning the
   * spacing on six balloons must not quietly write six sizes down as well.
   */
  function setLettering (patch: Partial<Lettering>) {
    // One step for the selection, folded while the same fields keep changing,
    // so a slider drag is one step on the timeline like every other drag. It
    // was `update` a block at a time, which folds only runs of one block — so
    // with several picked every tick filed a step each, and a second of
    // dragging pushed the rest of the history off the end.
    updateMany(
      selected.value.map((block) => ({ id: block.id, patch: { style: { ...block.style, ...patch } } })),
      undefined,
      `lettering:${selection.value.join()}:${Object.keys(patch).sort().join()}`,
    )
  }

  /** Back to the defaults, by having nothing of its own to say. */
  function resetLettering () {
    updateMany(selected.value.map((block) => ({ id: block.id, patch: { style: undefined } })))
  }

  /**
   * Change one block, and file it on the timeline.
   *
   * The one door. Every edit to a block comes through here — the transform tool,
   * the nudge keys, the block list, the text panel, the type menu, the lettering
   * controls — which is what lets undo be recorded in a single place instead of
   * being remembered at a dozen call sites and forgotten at the thirteenth.
   *
   * What is being written decides what folds into what: a drag writes the same
   * fields on every pointer move and comes out one step, while letting go and
   * changing something else about the same block writes different fields and
   * starts a new one. See `recordBlock`.
   */
  function update (id: string, patch: Partial<Block>) {
    const here = page.value
    const block = here?.blocks.find((candidate) => candidate.id === id)

    if (!block || !here) return

    const before = blockState(block)

    Object.assign(block, patch)

    recordBlock(here.id, block, before, `${id}:${Object.keys(patch).sort().join(',')}`)
  }

  /**
   * Change several blocks at once, and file the lot as one step.
   *
   * The same door as `update` — the edits still go through one place and are
   * still recorded there — widened for the utilities that act on a selection
   * rather than on a block.
   *
   * Deliberately not a loop over `update`, and that is the whole reason it
   * exists. `update` files a step per block and `recordBlock` folds only onto
   * the block the step above it is already holding, so transposing six balloons
   * that way comes out as six steps: one press of a button, six presses of
   * Cmd+Z. Grouping cannot be inferred from a run of single edits either, since
   * "these were one act" is something only the caller knows — so it is said,
   * once, here. See `BlocksEntry`.
   *
   * Top level only, like `update`: the utilities on the block panel work on the
   * selection, and a column of a split balloon is not something the selection
   * holds on its own.
   *
   * `pageId` names which page, and defaults to the one on screen because that
   * is what every button pressing this means. A chapter-wide run does not — a
   * translation lands on page forty while page one is being looked at, and
   * without naming the page those lines would be written onto whichever page
   * the reader happened to have turned to. The same reason `setBlocks` takes an
   * id and for the same class of caller.
   */
  function updateMany (patches: { id: string, patch: Partial<Block> }[], pageId?: string, merge?: string) {
    const here = pageId === undefined
      ? page.value
      : pages.value.find((candidate) => candidate.id === pageId)

    if (!here || !patches.length) return

    const edits: BlocksEntry['edits'] = []

    for (const { id, patch } of patches) {
      const block = here.blocks.find((candidate) => candidate.id === id)

      if (!block) continue

      const before = blockState(block)

      Object.assign(block, patch)
      edits.push({ blockId: id, before, after: blockState(block) })
    }

    recordBlocks(here.id, edits, merge)
  }

  /**
   * Put a block on the page by hand, and file it on the timeline.
   *
   * The other way a block arrives is a reading, and the two do not fold into
   * one however much it looks like they should. A reading lands a whole page of
   * blocks through `setBlocks` — a *replacement*, because reading a page again
   * means the old boxes came off the same scan and have to go — while this is
   * one block appearing among whatever is already there, with nothing to say
   * about the rest. What they do share is the shape of a block, and each writes
   * it once: `toBlocks` on the way in from a reading, here on the way in from a
   * pointer.
   *
   * Defaults are what an unread block honestly is. No `source`, because nothing
   * was read off the page — that is the whole difference between this and the
   * region tools, which are about what is printed. No `style`, so it is set the
   * way every other block is until somebody says otherwise. Full confidence,
   * because a line somebody typed is not a guess about what a page says.
   *
   * Sound effects by default: this exists for lettering with no scan behind it
   * — a drawn-in effect, a sign, a note — and the SFX plate is the row a
   * letterer turns off to see what is theirs rather than the page's. It is one
   * menu away in the Blocks panel for the cases where it is a caption.
   *
   * Null when the plate that block would land on is hidden or locked: a block
   * made where it cannot be drawn is one the reader cannot see, cannot select
   * and would place again.
   */
  function addBlock (box: PageBox, patch: Partial<Block> = {}): Block | null {
    const here = page.value

    if (!here) return null

    const block: Block = {
      // Its own namespace. `read:` means a reading with no row yet and `block:`
      // means a row — see `rowOf` — and a placement is neither, so calling it
      // either would be a claim about where it came from.
      id: `text:${crypto.randomUUID().slice(0, 8)}`,
      type: 'sfx',
      ...box,
      source: '',
      translation: '',
      confidence: 100,
      hidden: false,
      ...patch,
    }

    if (!reach.value.has(plateOf(block))) return null

    here.blocks.push(block)

    // Read back rather than handed on: what went in is a plain object and what
    // the list holds is the reactive one, and a caller editing the former would
    // be editing a copy nothing draws.
    const added = here.blocks[here.blocks.length - 1]!

    recordMade(here.id, added, here.blocks.length - 1)

    return added
  }

  /**
   * Take a block off the page as though it had never been put there.
   *
   * The one deletion that is not an edit. A text block placed, typed into and
   * left empty is a gesture that came to nothing, and filing it — the
   * placement, the keystrokes, the removal — leaves a run of steps whose only
   * effect, pressed one at a time, is to put an invisible box back on the page
   * and take it off again. `removeBlock` is the honest path for everything a
   * reader means; this one is for undoing a press on their behalf.
   *
   * Top level only, and that is not a limitation: the blocks this can reach are
   * the ones just placed, and nothing places a column of a split balloon.
   *
   * By page rather than on the open one, because the press that abandons a
   * placement is often the one that turned to another page.
   */
  function dropBlock (id: string) {
    for (const here of pages.value) {
      const at = here.blocks.findIndex((candidate) => candidate.id === id)

      if (at === -1) continue

      here.blocks.splice(at, 1)
      forgetBlock(id)

      return
    }
  }

  /**
   * Take a block off the page.
   *
   * Whole and undoable — see `recordGone`, which keeps the block itself rather
   * than a patch of it, because there is nothing left to patch once it is out
   * of the list. Its index goes with it so that putting it back puts it back
   * *there*: a block restored at the end would renumber every one after it,
   * and the numbers are how a letterer says which balloon they mean.
   *
   * The selection is left to the watcher above that prunes ids nothing holds
   * any more — one rule about that rather than one here and one there, and it
   * covers undo putting the block back as well as this taking it away.
   */
  function removeBlock (id: string) {
    const here = page.value

    if (!here) return

    // Top level first, then the pieces of each split balloon — a column of a
    // sound effect is a block like any other and is deleted the same way.
    const lists: { list: Block[], parent: string | null }[] = [
      { list: here.blocks, parent: null },
      ...here.blocks
        .filter((block) => block.children?.length)
        .map((block) => ({ list: block.children!, parent: block.id })),
    ]

    for (const { list, parent } of lists) {
      const at = list.findIndex((candidate) => candidate.id === id)
      const block = at === -1 ? null : list[at]

      if (!block) continue

      list.splice(at, 1)
      recordGone(here.id, block, at, parent)

      return
    }
  }

  /**
   * Put a reading onto a page, in place of whatever was there.
   *
   * Replacing rather than adding is what reading a page again means: the
   * blocks came off the same scan, so keeping the old ones would leave every
   * balloon doubled. Work already done on them goes with them, which is why
   * the panel that calls this says so before it does.
   *
   * By page id rather than by index, for the reason `identified` gives: a
   * reading is slow enough that the pages may have been replaced under it,
   * and blocks landing on whatever is now in slot four would be worse than
   * no blocks at all.
   */
  function setBlocks (id: string, blocks: Block[]) {
    const target = pages.value.find((candidate) => candidate.id === id)

    if (!target) return

    target.blocks = blocks

    /*
     * Whatever was selected and is gone now leaves the selection, or the panels
     * would stay lit for blocks nothing can show — but only on the page on
     * screen, and only when something did go.
     *
     * The selection is of the page on screen's blocks, and this is called for
     * every page of a chapter: a whole-chapter read, a restore, blocks given
     * their rows, a collaborator's edit. It used to filter the selection
     * against whichever page it was handed and assign the result every time —
     * so a reading landing on page forty emptied a selection on page three, and
     * even an empty selection came back as a new array, which every row of the
     * block lists, the Blocks panel and the board's chrome read as a change and
     * drew again. Once a page, for every page read.
     *
     * Assigned only when an id actually went, as `keepSelection` already does.
     */
    if (target !== page.value) return

    const kept = new Set(blocks.map((block) => block.id))

    if (selection.value.some((chosen) => !kept.has(chosen))) {
      selection.value = selection.value.filter((chosen) => kept.has(chosen))
    }
  }

  /**
   * Change one row of the stack, wherever in the tree it is.
   *
   * By id rather than by handing the row itself about: a row is drawn by a
   * component that was given it as a prop, and a prop is not that component's
   * to write to. Looking it up here keeps the one copy that matters — the one
   * in the state — the only one anybody edits.
   */
  function setLayer (id: string, patch: Partial<StackLayer>) {
    const node = findLayer(layers.value, id)

    if (node) Object.assign(node, patch)
  }

  /**
   * Add an adjustment row, and select it so its controls are already open.
   *
   * It lands at the top level, directly above whichever row holds the cleaned
   * plate — under the lettering and over everything the page arrived as. Two
   * reasons, and both are about what an adjustment is *for* here:
   *
   * - the cleaned patches are crops of the *unadjusted* scan, so an adjustment
   *   over the art alone would leave every cleaned balloon a mismatched
   *   rectangle. Above them both, the repair is adjusted along with the page
   *   it sits in and the seam stays invisible.
   * - the lettering is set in colours somebody chose. Levels dragged to fix a
   *   grey scan should not also wash out the text on top of it.
   *
   * Beside the group rather than inside it, so that the Cleanup group's own
   * eye stays a statement about the repair: dropped in among its children,
   * hiding the repair would also silently restore the scan's brightness.
   *
   * Deliberately not "above whatever is selected". A workspace opens with a
   * row already highlighted that nobody picked, so that rule quietly put the
   * first adjustment anybody added at the very top of the stack. Somewhere
   * predictable, and a drag away from anywhere else.
   */
  function addAdjustLayer (type: AdjustmentType) {
    const row = newAdjustLayer(type)

    // The top-level row the cleaned plate lives in — itself, or the group it
    // is filed under. Falling back to the art, and to the top of the stack for
    // a stack somebody has dragged both of them out of.
    const holds = (candidate: StackLayer, plate: PlateId) =>
      candidate.plate === plate || (candidate.children ? !!findLayer(candidate.children, plate) : false)

    const found = layers.value.findIndex((candidate) => holds(candidate, 'clean'))
    const at = found === -1 ? layers.value.findIndex((candidate) => holds(candidate, 'art')) : found

    layers.value.splice(at === -1 ? layers.value.length : at, 0, row)
    layerSelection.value = row.id

    return row.id
  }

  /**
   * Clip an adjustment to the row below it, or let it go again.
   *
   * Adjustments only, and for the same reason only they can be deleted: this
   * is a thing a reader made and may unmake. A plate clipped to another plate
   * would be a claim about the page that the page cannot honour.
   */
  function setLayerClipped (id: string, clipped: boolean) {
    const row = findLayer(layers.value, id)

    if (row?.adjust) row.clipped = clipped
  }

  /** What an adjustment is clipped to, for the row that has to draw it. */
  const clipTarget = (id: string) => clipBase(layers.value, id)

  /**
   * A blank sheet to paint on, above whatever is selected.
   *
   * Numbered by counting the sheets already in the stack, so the names read as
   * a sequence rather than as a set of identical rows — and counted rather
   * than remembered, so deleting Layer 2 does not leave the next one called
   * Layer 4.
   */
  function addPaintLayer () {
    let made = 0

    const count = (rows: StackLayer[]) => {
      for (const row of rows) {
        if (row.paint) made++
        if (row.children) count(row.children)
      }
    }

    count(layers.value)

    const row = newPaintLayer(`Layer ${made + 1}`)
    const beside = layerSelection.value ? locateLayer(layers.value, layerSelection.value) : null

    if (beside) beside.list.splice(beside.index, 0, row)
    else layers.value.unshift(row)

    layerSelection.value = row.id

    return row.id
  }

  /**
   * A picture placed on this page, at the bottom of the cleanup group.
   *
   * Somewhere specific rather than "above whatever is selected", because the
   * reason anybody places one is a clean raw and there is a right answer for
   * that: under the lettering, over the art, and *under the repairs*. The last
   * of those is the one worth stating — a clean with one balloon the cleaner
   * missed should still be repairable, and the repair has to land on top of the
   * clean rather than beneath it. Bottom of the group gives all three.
   *
   * Inside `cleanup` rather than beside it so the group's own eye covers it,
   * which is what makes the Read preset go on meaning "the page as printed":
   * that stage hides the whole group, and a placed clean left at the top level
   * would sit over the printed lettering somebody is trying to check a reading
   * against.
   *
   * Falls back to the top of the stack for a stack somebody has dragged the
   * group out of — a wrong place is better than refusing to place at all, and
   * it is one drag from anywhere else.
   */
  function addImageLayer (image: PlacedImage) {
    const row = newImageLayer(image)
    const cleanup = findLayer(layers.value, 'cleanup')

    if (cleanup?.children) {
      cleanup.children.push(row)
      cleanup.open = true
    } else {
      layers.value.unshift(row)
    }

    layerSelection.value = row.id

    return row.id
  }

  /**
   * A blank group, for arranging what the stack has grown to hold.
   *
   * Above the selected row and in its own list, so it lands where you were
   * looking — including inside a group, if that is where you were. Rows go
   * into it by being dragged, which is machinery the panel already has.
   */
  function addGroupLayer () {
    const row = newGroupLayer()
    const beside = layerSelection.value ? locateLayer(layers.value, layerSelection.value) : null

    if (beside) beside.list.splice(beside.index, 0, row)
    else layers.value.unshift(row)

    layerSelection.value = row.id

    return row.id
  }

  /** Whether the row picked right now is one the reader may remove. */
  const removable = computed(() => {
    const row = layerSelection.value ? findLayer(layers.value, layerSelection.value) : null

    return Boolean(row && layerRemovable(row))
  })

  /**
   * Take a row out of the stack — see `layerRemovable`, which is where the rule
   * lives, because the panel is not the only thing that will ever delete a row
   * and "what may go" is a fact about the stack rather than about a button.
   *
   * A group goes with whatever is inside it, which is why the rule looks at the
   * whole subtree: a group of three adjustments is three adjustments, and
   * deleting it is what deleting them all looks like.
   */
  function removeLayer (id: string) {
    const found = locateLayer(layers.value, id)
    const row = found?.list[found.index]

    if (!found || !row || !layerRemovable(row)) return

    found.list.splice(found.index, 1)

    if (layerSelection.value === id) layerSelection.value = null

    // And the strokes painted on any sheet that went with it. The server's go
    // by cascade when the stack is saved; this browser's copy has to be let go
    // of here, or it stays on disk for a surface nothing can open again. Not
    // undoable, and neither is the removal — a sheet deleted is gone.
    const hash = page.value?.scan?.hash
    const sheets: string[] = []
    const collect = (rows: StackLayer[]) => {
      for (const one of rows) {
        if (one.paint) sheets.push(one.id)
        if (one.children) collect(one.children)
      }
    }

    collect([row])

    if (hash && sheets.length) {
      const paint = usePaintCache()

      for (const sheet of sheets) paint.drop(`${hash}:${sheet}`)
    }
  }

  // The selection's own upkeep — see `keepSelection` — set up once for the tab
  // rather than once per call.
  if (import.meta.client && !upkeep) {
    upkeep = effectScope(true)
    upkeep.run(() => keepSelection(useComic()))
  }

  return {
    open,
    pages,
    title,
    at,
    page,
    selection,
    selected,
    anchor,
    keyed,
    keyBlock,
    writing,
    reach,
    pickable,
    blockShown,
    blockPickable,
    zoom,
    pan,
    room,
    eased,
    zoomAt,
    resetView,
    layers,
    layerSelection,
    layerDrag,
    eyeDrag,
    plates,
    pile,
    adjusts,
    sheets,
    placed,
    inked,
    inkedMask,
    translate,
    go,
    epoch,
    reset,
    openImages,
    appendImages,
    addBlankPage,
    movePage,
    removePage,
    renamePage,
    measure,
    identified,
    attach,
    select,
    setSelection,
    selectAll,
    selectWithin,
    styleOf,
    balloonOf,
    setDown,
    framing,
    writesLetter,
    framedBox,
    resetFrame,
    lettering,
    setLettering,
    resetLettering,
    update,
    updateMany,
    addBlock,
    removeBlock,
    dropBlock,
    setBlocks,
    setLayer,
    addAdjustLayer,
    addGroupLayer,
    addPaintLayer,
    addImageLayer,
    removable,
    removeLayer,
    setLayerClipped,
    clipTarget,
    setLayerVisible,
    setLayerLocked,
    layerEditable: editable,
    beginEyeDrag,
    sweepEye,
    endEyeDrag,
    moveBlock,
    moveLayer,
    endLayerDrag,
  }
}

/** The colour a type is drawn in, on the page and in the list, in one place. */
export const BLOCK_TONE: Record<BlockType, string> = {
  bubble: 'text-sky-400',
  caption: 'text-violet-400',
  sfx: 'text-amber-400',
  garbage: 'text-red-400',
}

/**
 * Text standing in for a translation that has not been made yet — the original,
 * shown where the lettering will go.
 *
 * Here beside `BLOCK_TONE` for the reason that record exists: three surfaces
 * draw this same state — the block list, the blocks twirled open under a layer
 * row, and the lettering plate on the page itself — and a tone written out at
 * each is a tone that will be changed at two of them.
 *
 * Orange rather than the grey each of them used to carry. Grey was saying the
 * wrong thing on both surfaces at once. In the list it is what a row that
 * *cannot be reached* wears — a block on a hidden or locked layer — so spending
 * it here said "disabled" about the page's entire remaining work. On the page
 * it was worse: the scans are black and white, so grey type over grey art is
 * the one colour that will not separate from what is under it. Orange says
 * unfinished, which is what this is, and it is the thing a letterer is actually
 * counting down.
 *
 * One shade, no dark variant, unlike anything else that spans both. It has to
 * hold on the panel in either scheme *and* on white paper, which rules out a
 * `dark:` pair — the plate does not follow the interface theme, and a shade
 * light enough for a dark panel disappears on the page. `orange-600` clears the
 * text minimum on all three, which is the trap the words "dark orange" invite:
 * darker still would fail the dark panel instead.
 */
export const STANDING_IN_TONE = 'text-orange-600'

/**
 * Keep the selection pointing at blocks that are there to be picked, and the
 * key at one of them — made once, in `upkeep`, from a `useComic` of its own.
 */
function keepSelection ({ reach, page, pickable, selection, keyed }: ReturnType<typeof useComic>) {
  /**
   * A layer switched off or shut takes its blocks out of the selection with it.
   *
   * Without this the selection outlives what it points at: hide Lettering with
   * six balloons picked and the panels beside the page go on offering to align
   * and retype six things that are no longer on it, and the first of those to be
   * acted on edits a page the reader cannot see. Held here rather than checked
   * by each panel for the same reason `reach` exists at all.
   */
  watch(
    [
      reach,
      // And on the blocks themselves, by id: a layer going dark is one way for
      // a selected block to stop being reachable, and being deleted is the
      // other. Watching only the first left a deleted block selected, so the
      // panels beside the page went on offering to retype and align something
      // that was no longer on it.
      //
      // The ids joined rather than the list, so this fires when the set of
      // blocks changes and not on every pixel of every drag.
      () => (page.value?.blocks ?? []).map((block) => block.id).join(),
    ],
    () => {
      const left = new Set(pickable.value.map((block) => block.id))

      if (selection.value.some((id) => !left.has(id))) {
        selection.value = selection.value.filter((id) => left.has(id))
      }
    },
  )

  /**
   * The key is only ever one of the selected — see `keyed`.
   *
   * One watcher on the selection rather than a line at each place that changes
   * it, because every one of them ends at this ref: a pick, a band, Select All,
   * a page turned, a layer switched off, a block deleted, an edit arriving from
   * a collaborator. Cleared rather than remembered, so a block picked again
   * later comes back an ordinary member of the selection instead of silently
   * resuming a role nobody could see it still had.
   */
  watch(selection, (ids) => {
    if (keyed.value && !ids.includes(keyed.value)) keyed.value = null
  })
}
