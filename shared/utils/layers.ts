/**
 * What the page is built out of: what rows there are, in what order they paint,
 * which of them draw, and which are open to the tools.
 *
 * One derivation, in one place, because everything with an opinion about the
 * stack has to hold the same one. The canvas paints the plates, the panel lists
 * them, the tools ask which of them they may touch, and the server will one day
 * composite them — four answers each written to its own local need is four
 * things to fix every time the stack changes shape, and the one that gets missed
 * is the bug where a row dragged to the top still paints at the bottom.
 *
 * It lives in `shared/` for the reason `raster.ts` does: the composite has to
 * come out the same wherever it is worked out, and two copies of this that
 * disagree would put the same page together two ways.
 */
import { type Adjustment, ADJUSTMENTS, type AdjustmentType, newAdjustment } from './adjust'

/**
 * The plates the canvas can actually draw, listed for the sake of the ones a
 * stack has no row for — see `plateStates`. A layer earns a plate by being a
 * thing that shows up on the page; everything else in the tree is a group, and
 * a group is only ever the sum of what is under it.
 *
 * The mask was taken out of this list once, on the grounds that a mask is a view
 * of a plate rather than a plate of its own — and rightly, because the row that
 * used to be here drew the block boxes rather than the pixels anybody had
 * actually painted. A row that cannot be wrong about anything cannot tell you
 * anything either.
 *
 * It is back because what it holds has changed. A mask is no longer only the
 * threshold's opinion about where the ink is: it is that *plus* the strokes
 * somebody drew to correct it — see `useMaskEdits`, and the brush that adds to
 * and wipes from it. Those strokes exist only because a person made them, so
 * they have to be stored, shared, undone and ordered against everything else on
 * the page, and a row of the stack is exactly the thing that does all four.
 *
 * What is drawn on it is the *effective* mask — the automatic half composited
 * with the corrections — so the objection above is answered rather than
 * ignored: the row now shows what will actually be painted out.
 */
export const PLATES = ['dialogue', 'sfx', 'mask', 'clean', 'art'] as const

export type PlateId = typeof PLATES[number]

/**
 * A picture placed on a page, as the stack records it.
 *
 * The **hash is the identity**, and it is the image's own — not the scan's.
 * That is the difference between this and everything else the app files under a
 * digest: a thumbnail or a repair is *derived from* a page and so belongs to
 * it, while a placed image is a thing in its own right that happens to have been
 * put on one. Keyed by itself, the same clean placed on two pages is stored
 * once, and a peer can be asked for it by hash exactly as it is asked for a
 * scan.
 *
 * `ext` rides along because the private filesystem keeps no MIME type: a file
 * read back is typed from its name, so what it was called on the way in is the
 * whole of what it claims to be on the way out. It is held to a list here — in
 * `shared/`, one derivation — because a reference travels: it goes to the
 * server and comes back, and it reaches a collaborator, who will build a
 * filename out of it. Anything arriving from off this machine that is going to
 * be a filename is worth spelling out rather than trusting.
 *
 * `width` and `height` are its own pixels, which need not be the page's. A
 * clean is routinely twice the resolution of the scan in hand, and knowing the
 * shape without decoding is what lets the canvas lay it out on the first frame.
 */
export const PLACED_EXTENSIONS = ['png', 'jpg', 'webp', 'avif', 'gif'] as const

export type PlacedExtension = typeof PLACED_EXTENSIONS[number]

export interface PlacedImage {
  hash: string
  ext: PlacedExtension
  /** What the file was called, so a row can be recognised by a person. */
  name: string
  width: number
  height: number
}

/** A row of the stack: a group with children, or a plate that draws. */
export interface StackLayer {
  id: string
  label: string
  /** What it is for, in a few words. */
  hint?: string
  visible: boolean
  /** Nought to a hundred, and multiplied by every group above it. */
  opacity: number
  /** Shut to the tools. A group's lock covers everything filed under it. */
  locked?: boolean
  /**
   * A row of the page itself, whose lock is not the reader's to open. The scan
   * as it arrived is the one thing here with no earlier version to go back to,
   * so it is the one thing the tools never get at.
   */
  fixed?: boolean
  /** What it draws. A group draws nothing itself. */
  plate?: PlateId
  /**
   * A blank sheet of its own to paint on.
   *
   * The five plates are what a translated page is made of and are not the
   * reader's to invent — but a sheet to draw on over the top of them is
   * something every editor has, and nothing about it belongs to the pipeline:
   * it holds whatever somebody put there. Its pixels live where every other
   * mark does, in the stroke log, on a surface of its own keyed by this row's
   * id — see `CanvasPaint`.
   */
  paint?: boolean
  /**
   * A picture somebody put on the page — see `PlacedImage`.
   *
   * The third kind of row a reader can make, beside a sheet and a group, and
   * the one that arrives with its pixels already decided. A clean raw is what
   * it was added for: a group that has a cleaner has the lettering taken out by
   * hand, at the source resolution, and no inpainter is going to beat that — so
   * placing that image and choosing `NO_CLEANER` is the whole of "this chapter
   * is already cleaned". It is not limited to that. A redraw, a logo, a credits
   * strip and an effect somebody drew elsewhere are all the same thing to the
   * stack.
   *
   * Only the reference is here. The bytes live in the origin's private
   * filesystem under this hash — see `app/utils/placed.ts` — because a stack
   * row is synced to the server and the server holds no pixels.
   */
  image?: PlacedImage
  /**
   * What it does to everything below it — see `shared/utils/adjust.ts`. A row
   * carrying one of these draws nothing of its own either: it is a standing
   * instruction about the plates that paint under it, and `plateAdjusts` is
   * where that instruction is handed to them.
   */
  adjust?: Adjustment
  /**
   * Clipped to the row below it, rather than reaching everything under it.
   *
   * Only meaningful on an adjustment. Photoshop's clipping mask, minus the
   * half we get for nothing: the alpha clip is already how a filter behaves —
   * it changes painted pixels and leaves transparent ones transparent, so an
   * adjustment on the cleaned plate touches the patches and not the space
   * between them. What is left is the useful half, the reach.
   *
   * It exists because containment cannot say everything. A group boundary is
   * the only thing that stops an adjustment, so a plate at the top level — the
   * lettering — could not be adjusted on its own at any position: above it
   * caught all five plates and below it caught the other four. This says
   * "that one" directly.
   */
  clipped?: boolean
  children?: StackLayer[]
  /** A group's twirl. Meaningless on a plate, which has nothing to open. */
  open?: boolean
}

/** How a plate ends up on the page, once every group above it has had its say. */
export interface PlateState {
  /** Larger paints later, so it sits above. */
  z: number
  visible: boolean
  /** Nought to one — every group's percentage multiplied through. */
  opacity: number
  /** Whether the tools may touch it: its own lock, or one it inherits. */
  editable: boolean
}

/**
 * A row that puts something on the page, once the groups above it have had
 * their say: one of the five plates, or somebody's own sheet of paint.
 *
 * `key` is what everything downstream files it under — the plate's id for a
 * plate, the row's id for a painted sheet. One namespace, because the canvas
 * and the adjustments only want to know "which of the things being drawn is
 * this", and having to ask "and what kind is it first" is how two lists end up
 * disagreeing about the same row.
 */
export interface Drawn extends PlateState {
  key: string
  /**
   * Which of the three it is.
   *
   * Said outright rather than worked out from what is absent, and that is a
   * correction rather than a flourish. There were two kinds for a long time, so
   * "not a plate" meant "a sheet of paint" and `paintLayers` was written that
   * way — correct, and correct only because nothing else could draw. A placed
   * image is a third kind with no plate either, so the old test would have
   * handed every one of them to the canvas as a surface to paint on, and the
   * mistake would have been a blank canvas over the picture rather than an
   * error anybody could see.
   */
  kind: 'plate' | 'paint' | 'image'
  /** The plate it draws, or null for a sheet or a picture, which are only themselves. */
  plate: PlateId | null
  /**
   * The picture it draws, for `kind: 'image'`.
   *
   * Carried here rather than looked up from the row by id, because this is
   * already what a `Drawn` is for: everything the canvas needs to draw one
   * thing, so that drawing never has to walk the tree again.
   */
  image?: PlacedImage
  /** The stack row it came from. */
  layer: string
}

/**
 * Where everything that is *not* the page goes — the block boxes, the handles,
 * anything you reach for rather than look at. Above every plate and above any
 * number of them, so that adding rows to the stack can never bury the controls
 * for the stack.
 */
export const CHROME_Z = 100

/**
 * The stack a workspace starts with: the plates a translated page is actually
 * made of, in the order they sit.
 *
 * The scan at the bottom with its lettering still printed on it, a cleaned plate
 * painting that lettering out, and the new lettering on top. Turning the cleaned
 * plate off is how a repair gets checked against what it painted over — which is
 * the whole reason a translator wants layers, and why these are wired to the
 * canvas rather than merely listed.
 *
 * Cleanup is a group because it holds two rows that answer different questions.
 * The cleaned plate is what the repair *did*; the mask is what it was *told to
 * do*. The mask is off by default, because it is a working view — you turn it
 * on to see what will be painted out, or to correct it with the brush, and off
 * again to judge the result.
 *
 * The art is a group over a single row, which looks like ceremony and is not:
 * a group is the only thing an adjustment can be put *inside*, and "adjust the
 * scan and nothing else" is a thing worth being able to say. The lock stays on
 * the image itself rather than on the group around it — the scan as it arrived
 * is the one thing here with no earlier version to go back to, but the shelf it
 * sits on is ordinary furniture.
 *
 * Dialogue and Sound effects are plates that also hold the page's blocks. Not
 * as rows of this stack, which describes what a page is *made of* rather than
 * what happens to be on it, but as children the panel works out from whatever
 * page is open; see `PanelLayerRow`.
 *
 * ## This is what every page starts with, not what every page has
 *
 * A stack belongs to a page — see `layers.pageId`. It used to belong to the
 * chapter, and the trouble was not that it was shared but that it could not be
 * anything else: a sheet added to sketch over one awkward panel turned up on
 * all three hundred pages. So this is the seed each page is founded with, and
 * from then on the pages can differ.
 *
 * Keeping them the same is a gesture instead of a shape — the "all pages"
 * switch in the layers panel, which writes the stack in front of you to every
 * page of the chapter. Sameness is something somebody keeps saying, not
 * something the rows cannot help.
 */
export const DEFAULT_STACK: StackLayer[] = [
  {
    id: 'dialogue',
    label: 'Dialogue',
    hint: 'Bubbles and captions',
    visible: true,
    opacity: 100,
    plate: 'dialogue',
  },
  {
    id: 'sfx',
    label: 'Sound effects',
    hint: 'Lettering drawn into the art',
    visible: true,
    opacity: 100,
    plate: 'sfx',
  },
  {
    id: 'cleanup',
    label: 'Cleanup',
    hint: 'The repair that makes room for the lettering',
    visible: true,
    opacity: 100,
    open: true,
    children: [
      { id: 'mask', label: 'Mask', hint: 'What the repair paints out', visible: false, opacity: 55, plate: 'mask' },
      { id: 'clean', label: 'Cleaned plate', hint: 'The original lettering painted out', visible: true, opacity: 100, plate: 'clean' },
    ],
  },
  {
    id: 'original',
    label: 'Original art',
    hint: 'The page as it arrived',
    visible: true,
    opacity: 100,
    open: true,
    children: [
      { id: 'art', label: 'Image', hint: 'The scan, as it came in', visible: true, opacity: 100, locked: true, fixed: true, plate: 'art' },
    ],
  },
]

/**
 * Every row `DEFAULT_STACK` founds a page with, by uid.
 *
 * The allowlist a preset is held to. A preset says what the *page* is made of —
 * the five plates and the two groups over them — and must never be able to
 * reach a sheet, a group or an adjustment somebody added: those belong to the
 * page they were made on and are nobody else's to rearrange. Derived from the
 * default stack rather than written out again, so a plate added there cannot be
 * forgotten here.
 */
export function standardUids (): Set<string> {
  const out = new Set<string>()

  const walk = (rows: StackLayer[]) => {
    for (const row of rows) {
      out.add(row.id)
      walk(row.children ?? [])
    }
  }

  walk(DEFAULT_STACK)

  return out
}

/** What a preset says about one standard row. */
export interface PresetRow {
  visible: boolean
  opacity?: number
  /**
   * Shut to the tools under this preset.
   *
   * Absent means "leave the lock as it is", which is not the same as false: the
   * scan is `fixed` and its lock is not a preset's to open — see `StackLayer`.
   */
  locked?: boolean
}

export type PresetId = 'read' | 'clean' | 'letter' | 'final'

/**
 * A stage of the work, as an arrangement of the standard plates.
 *
 * The panel's preset buttons. Choosing one is saying *what you are about to
 * do*, and the stack follows: the plates that stage needs are shown, the ones
 * that would be in the way are hidden, and everything except what you are
 * working on is locked so a stroke cannot land on the wrong plate — the mask
 * aside, which no stage locks (see `MASK_OPEN`).
 *
 * ## Why locking is half of it
 *
 * Hiding alone would not be enough and showing alone would not either.
 * `openPlates` asks for `visible && editable` before a tool may touch a plate,
 * so the two together are what actually decide where a brush can go — see the
 * failure named in that function, where the brush was armed over a group and
 * marked the repair instead. A preset is the one place that sets both at once
 * and therefore the one place they cannot drift apart.
 *
 * ## What a preset must never touch
 *
 * Anything not in `standardUids`. A sheet somebody added to sketch over one
 * panel is that page's, and a stage of work has no opinion about it — see
 * `layers.preset`, which enforces this on the server rather than trusting the
 * list that arrives.
 */
export interface LayerPreset {
  id: PresetId
  label: string
  hint: string
  rows: Record<string, PresetRow>
  /** The row this stage works on: selected, and the only one left unlocked. */
  works: string | null
}

/** Both groups, which have to be shown for anything inside them to draw. */
const GROUPS = {
  cleanup: { visible: true },
  original: { visible: true },
} satisfies Record<string, PresetRow>

/**
 * The mask, which no stage locks.
 *
 * Every stage used to lock it but Read, on the rule that everything but what
 * you are working on is shut. For the mask that rule is wrong, because the mask
 * brush is not a stage: it is how a repair that came back wrong is corrected,
 * and that is noticed from whichever stage you are in — Letter, when the
 * translation sits over a smudge; Final, when the page is looked at whole. Its
 * eye already does not gate its brush for that reason (see `inkedLayer`), and
 * the lock did, so choosing Clean — the stage *for* cleaning, and chapter-wide —
 * shut the mask brush out of every page. Unlocked rather than left alone, so
 * pressing a stage also opens a mask an earlier version of these presets shut.
 *
 * A mask stroke cannot land anywhere but the mask, so leaving it open cannot
 * send a mark to the wrong plate, which is what the other locks are for.
 */
const MASK_OPEN = { locked: false } satisfies Pick<PresetRow, 'locked'>

/** The scan. Shown by every stage and locked by all of them — it is `fixed`. */
const SCAN = { art: { visible: true } } satisfies Record<string, PresetRow>

export const LAYER_PRESETS: LayerPreset[] = [
  {
    id: 'read',
    label: 'Read',
    hint: 'The page as it was printed, to check what was read off it',
    /*
     * The repair and the translation are both *hidden*, which is the whole
     * point rather than an oversight: what a reading has to be checked against
     * is the lettering that was actually on the page, and the cleaned plate
     * exists to paint exactly that out. Nothing is locked — correcting a block
     * is the work this stage is for.
     */
    rows: {
      ...GROUPS,
      ...SCAN,
      /*
       * The whole cleanup group off, not merely the two plates inside it.
       *
       * For the standard rows this changes nothing — `mask` and `clean` are
       * already hidden here, and hiding their group hides exactly the same two
       * pixels. What it reaches is a row the reader put in that group, which is
       * where a **placed clean** lands by default (see `addImageLayer`), and
       * that is the thing this stage must not show: a picture of the page with
       * the lettering already taken out is precisely what you cannot check a
       * reading against.
       *
       * It is also the only lever available. A preset may not touch a row
       * outside `standardUids` — a reader's own rows belong to their page and
       * are nobody else's to rearrange — so the group's eye, which a preset may
       * set, is what carries the intent down to whatever is filed under it.
       */
      cleanup: { visible: false },
      dialogue: { visible: false },
      sfx: { visible: false },
      mask: { visible: false, ...MASK_OPEN },
      clean: { visible: false },
    },
    works: null,
  },
  {
    id: 'clean',
    label: 'Clean',
    hint: 'The repair, with the mask over it',
    rows: {
      ...GROUPS,
      ...SCAN,
      dialogue: { visible: false, locked: true },
      sfx: { visible: false, locked: true },
      // The mask's own default — faint enough to see the art through, strong
      // enough to see where the repair will reach. Open, like every stage
      // leaves it: see `MASK_OPEN`.
      mask: { visible: true, opacity: 55, ...MASK_OPEN },
      clean: { visible: true, locked: false },
    },
    works: 'clean',
  },
  {
    id: 'letter',
    label: 'Letter',
    hint: 'The translation over the repaired art',
    rows: {
      ...GROUPS,
      ...SCAN,
      dialogue: { visible: true, locked: false },
      sfx: { visible: true, locked: false },
      mask: { visible: false, ...MASK_OPEN },
      clean: { visible: true, locked: true },
    },
    works: 'dialogue',
  },
  {
    id: 'final',
    label: 'Final',
    hint: 'The page as it ships, with only the mask left open to correct',
    rows: {
      ...GROUPS,
      ...SCAN,
      dialogue: { visible: true, locked: true },
      sfx: { visible: true, locked: true },
      mask: { visible: false, ...MASK_OPEN },
      clean: { visible: true, locked: true },
    },
    works: null,
  },
]

/**
 * Every plate the page is made of, bottom of the pile first — the order the
 * canvas composites in, and the order a bake would write them.
 *
 * A group is not a thing on the page, it is a thing said about the things under
 * it: hiding one hides its children, half-fading one halves whatever they were
 * already at, and locking one holds all of them. Working that out here, once,
 * is what lets the canvas draw a flat list and never learn that a group exists.
 */
export function paintOrder (stack: StackLayer[]): Drawn[] {
  const found: Drawn[] = []

  const walk = (rows: StackLayer[], visible: boolean, opacity: number, editable: boolean) => {
    for (const row of rows) {
      const on = visible && row.visible
      const through = opacity * (row.opacity / 100)
      const open = editable && !row.locked

      if (row.plate || row.paint || row.image) {
        found.push({
          key: row.plate ?? row.id,
          kind: row.plate ? 'plate' : (row.image ? 'image' : 'paint'),
          plate: row.plate ?? null,
          ...(row.image ? { image: row.image } : {}),
          layer: row.id,
          z: 0,
          visible: on,
          opacity: through,
          editable: open,
        })
      }

      if (row.children) walk(row.children, on, through, open)
    }
  }

  walk(stack, true, 1, true)

  // The stack is listed topmost first — the order the panel reads — so a plate's
  // height is its distance from the bottom of that list. Reversed on the way out
  // because a pile is drawn from the bottom up.
  return found.map((plate, i) => ({ ...plate, z: found.length - i })).reverse()
}

/**
 * The same pile keyed by plate, which is how the canvas asks: it knows which
 * plate it is drawing and wants to know how to draw it.
 *
 * Every plate has an entry whether the stack holds a row for it or not. A plate
 * with no row is off rather than absent — the canvas should not have to check
 * that a layer exists before asking whether to draw it, and a stack the reader
 * has dragged a row out of is not a reason for the page to throw.
 */
export function plateStates (stack: StackLayer[]): Record<PlateId, PlateState> {
  const out = {} as Record<PlateId, PlateState>

  for (const id of PLATES) out[id] = { z: 0, visible: false, opacity: 0, editable: false }

  for (const { plate, key: _key, layer: _layer, ...state } of paintOrder(stack)) {
    if (plate) out[plate] = state
  }

  return out
}

/** The sheets somebody has added, in the order they paint — see `Drawn`. */
export function paintLayers (stack: StackLayer[]): Drawn[] {
  return paintOrder(stack).filter((row) => row.kind === 'paint')
}

/** And the pictures somebody has placed, in the order they draw. */
export function imageLayers (stack: StackLayer[]): Drawn[] {
  return paintOrder(stack).filter((row) => row.kind === 'image')
}

/** One adjustment as a plate receives it: whose it is, what it does, how hard. */
export interface PlateAdjust {
  id: string
  adjust: Adjustment
  strength: number
}

/**
 * Which adjustments reach each plate, nearest-above first.
 *
 * An adjustment governs everything that paints *below* it — the panel's own
 * order, so dragging the row is how its reach is chosen, with the machinery
 * the stack already has. Worked out here rather than in the canvas for the
 * reason `paintOrder` is: the canvas applies these as CSS filters and a bake
 * will apply them as lookup tables, and the two must agree about which plate
 * gets which.
 *
 * Nearest-above first because that is application order: compositing runs
 * bottom-up, so the adjustment closest above a plate has its say before one
 * higher still — and a CSS filter list applies left to right.
 *
 * The eye is the bypass, and a hidden group takes its adjustments with it,
 * exactly as it takes its plates. Strength is the row's own opacity alone —
 * deliberately not multiplied through the groups the way paint is, because an
 * adjustment draws nothing: fading a group already fades the adjusted result,
 * and fading the adjustment *again* would count the same slider twice.
 */
export function plateAdjusts (stack: StackLayer[]): Record<string, PlateAdjust[]> {
  const out: Record<string, PlateAdjust[]> = {}

  for (const id of PLATES) out[id] = []

  const above: PlateAdjust[] = []

  const reading = (row: StackLayer): PlateAdjust | null =>
    row.adjust ? { id: row.id, adjust: row.adjust, strength: row.opacity / 100 } : null

  /**
   * `above` is the reach, innermost last, so reversing it gives nearest first.
   *
   * Both kinds of scope come out of one rule: a row's clips are pushed on just
   * before it is drawn and taken off again once it and everything inside it is
   * done. That single truncate does all the work — it spends a clipped
   * adjustment on the one row it was clipped to, and it stops an unclipped one
   * at the edge of the group it sits in, because both are "what was added for
   * this subtree".
   *
   * `waiting` is the run of clipped rows that have not met their base yet.
   * Several in a row all wait for the same one, which is what Photoshop does
   * and what the panel draws: a column of arrows over one layer.
   */
  const walk = (rows: StackLayer[], visible: boolean) => {
    let waiting: PlateAdjust[] = []

    for (const row of rows) {
      const on = visible && row.visible
      const found = reading(row)

      if (found && row.clipped) {
        if (on) waiting.push(found)

        continue
      }

      // An unclipped one joins the reach *before* the mark is taken, so it goes
      // on applying to the rows after this one as well as to this one.
      if (found && on) above.push(found)

      const outside = above.length

      // Whatever was clipped to this row applies to it and to everything under
      // it — clipping a group clips to its contents, not merely to its first
      // child, which is the whole meaning of pointing at a group.
      above.push(...waiting)

      // Keyed the way `Drawn` is, so a sheet of paint — or a picture somebody
      // placed — is adjusted by whatever is over it exactly as a plate would
      // be. An adjustment that stopped at the five would be one you could put
      // over somebody's own layer and watch do nothing.
      if (row.plate || row.paint || row.image) out[row.plate ?? row.id] = [...above].reverse()
      if (row.children) walk(row.children, on)

      above.length = outside
      waiting = []
    }
  }

  walk(stack, true)

  return out
}

/**
 * What a clipped row is clipped *to*, if anything.
 *
 * The next row below it in its own list that is not itself clipped — which is
 * what makes a stack of them all point at one base. Nothing at the bottom of a
 * list, and a row in that state adjusts nothing at all; the panel says so
 * rather than leaving a control that quietly does nothing.
 */
export function clipBase (stack: StackLayer[], id: string): StackLayer | null {
  const found = locateLayer(stack, id)

  if (!found || !found.list[found.index]?.clipped) return null

  for (let i = found.index + 1; i < found.list.length; i++) {
    const row = found.list[i]

    if (row && !row.clipped) return row
  }

  return null
}

/**
 * A fresh sheet to paint on, blank and on top of whatever it lands over.
 *
 * Numbered by the caller rather than here, because "Layer 3" is a fact about
 * the stack it is going into and this function has never seen it.
 */
export function newPaintLayer (label: string): StackLayer {
  return {
    id: `paint:${crypto.randomUUID().slice(0, 8)}`,
    label,
    hint: 'A blank sheet to paint on',
    visible: true,
    opacity: 100,
    paint: true,
  }
}

/**
 * A row for a picture somebody has placed.
 *
 * Labelled with the file's own name, because that is what the reader will
 * recognise it by — `1_clean.png` says which page's clean this is in a way
 * "Image 2" never could. Trimmed of its extension, which is noise in a narrow
 * panel column and is kept on the reference anyway.
 *
 * It holds no ink and it is removable, and both fall out of rules already
 * written rather than needing a case here: `layerInk` answers for what a row
 * can be *marked* with, and a picture is not marked, it is placed; and
 * `layerRemovable` refuses only rows that draw a plate, which this does not.
 */
export function newImageLayer (image: PlacedImage): StackLayer {
  return {
    id: `image:${crypto.randomUUID().slice(0, 8)}`,
    label: image.name.replace(/\.[a-z0-9]+$/i, '') || 'Image',
    hint: 'A picture placed on this page',
    visible: true,
    opacity: 100,
    image,
  }
}

/**
 * A fresh group, empty and open, ready to be put into the stack.
 *
 * A group is the one row a reader can make that is purely for arranging: it
 * draws nothing, and what it is *for* is what gets dragged into it. Now that
 * adjustments can be added without limit, a stack has something to arrange.
 */
export function newGroupLayer (label = 'Group'): StackLayer {
  return {
    id: `group:${crypto.randomUUID().slice(0, 8)}`,
    label,
    visible: true,
    opacity: 100,
    open: true,
    children: [],
  }
}

/**
 * Whether a row may be taken out of the stack.
 *
 * Nothing that draws, and nothing holding anything that draws. The plates are
 * what the page *is* — a stack you can delete the artwork from is one you can
 * lock yourself out of with a click — and a group is only as removable as its
 * contents, or deleting "Cleanup" would quietly take the repair with it.
 *
 * Stated as a property of the subtree rather than as a list of protected ids,
 * so a row added later is covered by the rule it already satisfies rather than
 * by somebody remembering to add it to a list.
 */
export function layerRemovable (row: StackLayer): boolean {
  if (row.plate) return false

  return (row.children ?? []).every(layerRemovable)
}

/**
 * A fresh adjustment row, ready to be put into the stack.
 *
 * Born as the identity — see `newAdjustment` — so adding one changes nothing
 * until a slider is moved, which is how adding should feel: a place to work,
 * not an opinion.
 */
export function newAdjustLayer (type: AdjustmentType): StackLayer {
  const named = ADJUSTMENTS.find((kind) => kind.type === type)

  return {
    id: `adjust:${crypto.randomUUID().slice(0, 8)}`,
    label: named?.label ?? 'Adjustment',
    hint: 'Adjusts everything below it',
    visible: true,
    opacity: 100,
    adjust: newAdjustment(type),
  }
}

/**
 * Every plate a tool may take hold of right now: on the page, and not shut.
 *
 * This is the question, and it is asked here so that no tool has to ask it for
 * itself. A tool that works out its own answer works it out from whatever it
 * happened to need at the time — the select tool from the eye, the brush from
 * the lock, the next one from neither — and then a layer switched off is still
 * selectable, a locked one still takes paint, and each of them is a separate
 * fix. One derivation means adding a tool costs nothing: it reads this set and
 * is correct about the stack by construction.
 *
 * Both halves matter and they are not the same. Hidden is not on the page, so
 * there is nothing there to take hold of. Locked is on the page and plainly
 * visible, and is the reader saying *not this one* — the whole point of a lock
 * being that you can go on seeing what you are not editing.
 */
export function openPlates (stack: StackLayer[]): Set<PlateId> {
  const open = new Set<PlateId>()

  for (const plate of paintOrder(stack)) {
    if (plate.plate && plate.visible && plate.editable) open.add(plate.plate)
  }

  return open
}

/**
 * What kind of mark a row can hold, if any — the gate every drawing tool asks
 * before it takes the pointer.
 *
 * Here rather than in the tools, for the reason `openPlates` gives a few lines
 * up and for the same failure: a tool that works out its own answer works it
 * out from whatever it happened to need at the time. The brush asked whether
 * the cleaned plate was reachable, which was the same question as "where does
 * this go?" for exactly as long as the cleaned plate was the only thing paint
 * could land on — and the day a blank layer existed, the brush was armed over
 * a group and quietly marked the repair instead. The mask brush asked nothing
 * at all, so a locked mask still took strokes.
 *
 * Three rows hold something. A blank layer is nothing *but* the marks on it;
 * the cleaned plate's retouching is paint by the same definition; and the mask
 * is a picture of what will be painted out, corrected with a brush of its own.
 * A group holds rows rather than pixels, the lettering plates draw blocks, and
 * the scan is the one thing on the page with no earlier version to go back to.
 */
export type Ink = 'paint' | 'mask'

export function layerInk (row: StackLayer): Ink | null {
  if (row.paint || row.plate === 'clean') return 'paint'
  if (row.plate === 'mask') return 'mask'

  return null
}

/**
 * The row that holds a given kind of mark, where there is exactly one to find.
 *
 * Only ever asked about the mask, which is the one ink with a single possible
 * home — paint has as many as there are sheets, and picking between them is
 * what the selection is for. Exported because the mask *tool* wants the same
 * row the mask *gate* does: reaching for the brush selects the layer it works
 * on, and both have to mean the same row or the panel would highlight one
 * thing while the brush marked another.
 */
export function inkLayer (rows: StackLayer[], ink: Ink): StackLayer | null {
  for (const row of rows) {
    if (layerInk(row) === ink) return row

    const inside = row.children ? inkLayer(row.children, ink) : null

    if (inside) return inside
  }

  return null
}

/**
 * The row a mark of a given kind would land on, or nothing.
 *
 * Null rather than a fallback onto whatever else could have taken it: the
 * layer you are looking at and the layer you are marking have to be the same
 * layer, and a brush with nowhere to go is better than a brush somewhere you
 * did not ask for.
 *
 * The two kinds are asked differently, and the difference is not arbitrary.
 * Paint has as many possible homes as there are sheets, so the selection is
 * what picks one. A mask has exactly one row it could ever go on, so there is
 * nothing to choose and requiring a choice would only be a step to forget.
 *
 * They differ on the eye for a reason of the same kind. Paint has to be seen
 * to be judged, so a hidden layer takes none. A mask is judged by the repair
 * it produces rather than by itself — it is off almost always, and off is
 * exactly when somebody is looking at the result and deciding it needs
 * correcting — so its own eye does not gate its brush. The lock gates both:
 * that one is the reader saying *not this*, and it means the same thing
 * whatever is being painted.
 */
export function inkedLayer (stack: StackLayer[], selected: string | null, ink: Ink = 'paint'): Drawn | null {
  const row = ink === 'mask'
    ? inkLayer(stack, 'mask')
    : (selected ? findLayer(stack, selected) : null)

  if (!row || layerInk(row) !== ink) return null

  const drawn = paintOrder(stack).find((candidate) => candidate.layer === row.id)

  if (!drawn?.editable) return null

  return ink === 'mask' || drawn.visible ? drawn : null
}

/** Depth-first, because a row's id is unique across the whole stack. */
export function findLayer (rows: StackLayer[], id: string): StackLayer | null {
  for (const row of rows) {
    if (row.id === id) return row

    const inside = row.children ? findLayer(row.children, id) : null

    if (inside) return inside
  }

  return null
}

/**
 * The list a row sits in, and where in it — which is what moving one needs and
 * what finding one cannot give you: a row on its own says nothing about whose
 * child it is.
 */
export function locateLayer (rows: StackLayer[], id: string): { list: StackLayer[], index: number } | null {
  const index = rows.findIndex((row) => row.id === id)

  if (index !== -1) return { list: rows, index }

  for (const row of rows) {
    const inside = row.children ? locateLayer(row.children, id) : null

    if (inside) return inside
  }

  return null
}

/**
 * Whether a row is open to the tools.
 *
 * A lock covers what is filed under it, so locking Lettering holds both its
 * plates without the reader ticking two rows — the same containment the eye has,
 * where switching a group off takes its contents with it. A row asked about here
 * answers for itself; `paintOrder` answers the same question per plate, and both
 * walk the tree the same way so they cannot come apart.
 */
export function layerEditable (stack: StackLayer[], id: string): boolean {
  const walk = (rows: StackLayer[], open: boolean): boolean | null => {
    for (const row of rows) {
      const here = open && !row.locked

      if (row.id === id) return here

      const inside = row.children ? walk(row.children, here) : null

      if (inside !== null) return inside
    }

    return null
  }

  // A row nothing can find is not editable: better a tool that refuses than one
  // that writes to a layer the stack has never heard of.
  return walk(stack, true) ?? false
}

/**
 * Move a row of the stack against another one — above it, below it, or into it
 * if it is a group.
 *
 * Taken out before the target is found, because both rows may be in the same
 * list and the target's index is only true once the dragged row is no longer
 * sitting in front of it.
 *
 * A group cannot be put inside itself or anything under it. That is the one move
 * that would take a branch of the tree out of the tree altogether — it would
 * still be somewhere, but nowhere anything could reach it.
 */
export function dropLayer (
  stack: StackLayer[],
  id: string,
  targetId: string,
  where: 'before' | 'after' | 'inside',
): void {
  if (id === targetId) return

  const from = locateLayer(stack, id)
  const row = from?.list[from.index]

  if (!from || !row) return
  if (row.children && findLayer(row.children, targetId)) return

  from.list.splice(from.index, 1)

  const put = (list: StackLayer[], index: number) => {
    list.splice(index, 0, row)
  }

  if (where === 'inside') {
    const target = findLayer(stack, targetId)

    // Nowhere to put it inside of, so it goes back where it came from rather
    // than nowhere at all.
    if (!target?.children) return put(from.list, from.index)

    target.open = true

    return put(target.children, 0)
  }

  const to = locateLayer(stack, targetId)

  if (!to) return put(from.list, from.index)

  put(to.list, to.index + (where === 'after' ? 1 : 0))
}
