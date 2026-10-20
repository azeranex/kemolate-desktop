<script setup lang="ts">
/**
 * What is drawn *on* the page: the plates in their pile, the lettering, the
 * repairs, the sheets and pictures, and the hit area of every block — the
 * inside of the board's sheet, as a component of its own.
 *
 * ## Why it is a component at all
 *
 * The board's stage wears the zoom and the pan as a transform, and that
 * transform was written by the same render as all of this. A render is the
 * component's, not the element's, so every frame of a pan, a zoom or a glide,
 * and every move of a rubber band, ran every per-block loop here again — the
 * repair placed, the lettering's CSS worked out and diffed, the hit area
 * restyled — to change one `transform` on the element above them. Measured on
 * the test chapter's page of eight balloons: 90 board renders for 90 frames of
 * pan, each redoing the lot; the cost is linear in the balloons, and a page of
 * lettering has three times as many.
 *
 * Out here, nothing this renders reads the pan or the zoom, so a view change
 * re-renders the transform and the chrome and leaves this alone. That rule is
 * the whole point of the split, and it is the easy one to break: a prop that
 * carries the view — or one built afresh on every board render, like an inline
 * `[]` or an arrow function — brings the per-frame render straight back. Hence
 * `view` is a getter the page art calls rather than the view itself, and the
 * lettering is held still by the sheet's `data-moving` rather than by a prop.
 *
 * ## Why it is still inside the sheet
 *
 * The engine's canvas has to be, and so does everything that shares its pile —
 * see "The engine canvas lives inside the sheet" in `CLAUDE.md`. The lettering
 * plates share one z-order with every raster layer, and the stage's transform is
 * a stacking context nothing outside it can slot into. So this renders the
 * sheet's *contents*, as a fragment, into the sheet element the board lays out
 * and still owns: its size, the pixelated sampling, and the pointer arithmetic
 * that is measured against it.
 */
import type { CSSProperties } from 'vue'
import type { LetterSpace, ShapeParts } from '~/utils/letterCss'
import type { RunRow } from '~/utils/raster/engine/run'
import type { ScanView } from '~/utils/raster/plan'

import { shapeFor, shapeOutline } from '#shared/utils/lettering'
import { boxPlaced, letterPlaced, letterSet, LINE_BOX, shapeParts, superIn } from '~/utils/letterCss'
import { engineGpu } from '~/utils/raster/engine/mode'
import { engineRun } from '~/utils/raster/engine/run'

const props = defineProps<{
  page: ComicPage
  /**
   * What one scan pixel is worth on the sheet — the board's, which knows how
   * big the room is. Changes with the window, never with the zoom.
   */
  unit: number
  /** The part of the page on screen, asked for rather than handed over — see `CanvasPageArt`. */
  view: () => ScanView
  /** The block being typed into on the page, and whether its box grows with the words. */
  editing: { id: string, grows: boolean } | null
  /** Whether the Select tool's grips are out — see the board's `gripped`. */
  gripped: boolean
  /** Whether the Text tool is out. */
  texting: boolean
}>()

/**
 * A block's hit area answering the pointer. The board decides what each press
 * means — it holds the transform gestures and the text editor — so these say
 * only which block and how.
 */
const emit = defineEmits<{
  press: [block: Block, event: PointerEvent]
  pick: [id: string, event: MouseEvent]
  hover: [id: string, over: boolean]
  type: []
  blur: []
  keys: [event: KeyboardEvent]
}>()

const {
  selection, plates, pile, adjusts, sheets, placed, inked, inkedMask,
  blockShown, blockPickable, styleOf, setDown, framedBox,
} = useComic()

const { tool, painting, stroking } = useTools()

/**
 * Whether one of the two brushes that hand a piece of the page to a reader is
 * out. Which of them it is only decides who reads the stroke, so the pair
 * mount one component and part on a single prop — see `REGION_TOOLS`.
 */
const regioning = computed(() => REGION_TOOLS.has(tool.value))

/* ---------- where things sit ---------- */

/**
 * The page's own pixel space, whichever half of the page knows it — `pageSize`
 * gives the scan's size where there is a scan and the workspace's record of it
 * where there is not. See the board, which argues this at length.
 */
const dims = computed(() => pageSize(props.page))

/** The page and its scale, as the shared lettering CSS wants them — see `app/utils/letterCss`. */
const space = computed<LetterSpace>(() => ({ page: dims.value, unit: props.unit }))

/**
 * Where a box sits, as the page's own percentages. Every plate that draws
 * something per block lays it out with this — the lettering, the box you click —
 * so they cannot drift apart when a block is moved.
 *
 * A `LetterBox` rather than a `Block`, and that is this file's half of the
 * split described on `Block.letter`: there are two boxes now, and each caller
 * has to say which of them it means. The words go in `letterBoxOf(block)`, the
 * handles on `framedBox(block)`, and the cleaning path — which is nowhere near
 * this file — goes on asking the block itself.
 */
function boxStyle (box: LetterBox) {
  return boxPlaced(box, space.value)
}

/**
 * How many times over a block is laid out: `SUPER` for a distorted one, one for
 * everything else.
 *
 * Every *length* on that element has to be multiplied by this, not just its
 * width and height — the font size, the letter spacing, the stroke. The element
 * is laid out this many times larger and scaled back down, so a length left
 * alone is a length divided by three when it is finally drawn. That is what a
 * page of distorted lettering set a third too small was: the box grew for the
 * sake of the raster and the type did not grow with it.
 *
 * Line height is the exception and needs nothing, being a multiple of the size
 * rather than a length of its own.
 */
const superOf = (block: Block) => superIn(letterBoxOf(block), space.value)

/**
 * The same box, but for the things made of *words*.
 *
 * A distorted one is laid out in pixels rather than percentages, because it has
 * to be laid out larger than it is drawn — see `SUPER` — and a percentage cannot
 * say that. Undistorted, this is `boxStyle` and nothing else, so the ordinary
 * page pays nothing.
 *
 * Only the lettering goes through here. The block's own outline stays on
 * `boxStyle`: its border and its number are chrome drawn at a fixed size, and
 * inside an element scaled back down by three they would come out at a third.
 */
function textStyle (block: Block) {
  return letterPlaced(letterBoxOf(block), space.value)
}

/**
 * A block's hit area, plus the height that keeps the boxes above every plate.
 *
 * The framed box, so that what you press is what a drag would move. On a
 * translated balloon whose lettering has been widened, the block's own box is a
 * rectangle around a repair nobody can see and would be a strange thing to have
 * to aim at.
 */
function blockStyle (block: Block) {
  return { ...boxStyle(framedBox(block)), zIndex: CHROME_Z }
}

/* ---------- the plates ---------- */

/**
 * How a plate is drawn: whether it is on, how far through, and where in the pile
 * it sits — all of it out of `plates`, so that dragging a row in the panel moves
 * what the canvas paints and not merely what the panel says.
 *
 * The z-index is why each plate is a positioned box of its own rather than a
 * bare fragment: a static element takes no z-index, and without one the plates
 * would paint in the order this file happens to list them, which is the fixed
 * order the stack exists to stop being fixed.
 *
 * ## And why none of them takes the pointer
 *
 * A plate is a picture, not a control. Each is a box the size of the whole
 * page, so a plate that answered to the pointer would shadow everything under
 * it across the entire sheet — which is exactly what the lettering plates were
 * doing to the brush: empty, invisible, sitting at the top of the pile, and
 * eating every press before it could reach the canvas two plates down. The
 * page had no lettering on it at all, so there was nothing to see and nothing
 * to blame.
 *
 * Anything inside a plate that genuinely is a control says so for itself —
 * only the paint canvas does, and only while a paint tool is out.
 */
function plateStyle (id: PlateId) {
  const filter = filterFor(id)

  return {
    opacity: plates.value[id].opacity,
    zIndex: plates.value[id].z,
    ...(filter ? { filter } : {}),
  }
}

/**
 * Every adjustment layer on the page, as one SVG filter apiece.
 *
 * A `feComponentTransfer` per row, its three channels wearing the same table
 * — see `adjustLut`, which is also what a bake will apply per pixel, so the
 * screen and the export are two readings of one number.
 *
 * `color-interpolation-filters` is set to sRGB deliberately. SVG filters work
 * in linear light by default, so a curve drawn against the 0–255 levels
 * somebody is actually looking at would land somewhere else entirely; sRGB
 * makes the table mean what the sliders say.
 */
const adjustFilters = computed(() => {
  const seen = new Map<string, { id: string, table: string }>()

  for (const list of Object.values(adjusts.value)) {
    for (const { id, adjust, strength } of list) {
      if (!seen.has(id)) seen.set(id, { id: filterId(id), table: lutTable(adjustLut(adjust, strength)) })
    }
  }

  return [...seen.values()]
})

/**
 * What a plate wears, as a CSS filter list.
 *
 * Per plate rather than one pane over the page, because `backdrop-filter`
 * cannot do this: curves need `feComponentTransfer`, and a `url(#…)` backdrop
 * filter does nothing in Chromium. Handing each plate the adjustments that
 * reach it composites in the right order anyway — nearest above applied
 * first, which is what `plateAdjusts` hands back — and costs no extra
 * elements, no stacking contexts, and nothing to keep in register.
 */
function filterFor (key: string) {
  return (adjusts.value[key] ?? []).map((one) => `url(#${filterId(one.id)})`).join(' ')
}

/** A row's filter, named so the id is safe in a URL reference. */
const filterId = (row: string) => `adjust-${row.replace(/[^a-z0-9]/gi, '')}`

/**
 * What a placed row actually draws, or nothing while its bytes are being found.
 *
 * The reference is on the row — see `Drawn.image` — and the pixels are keyed by
 * its hash in `usePlacedImages`, which is the split that lets a stack row be
 * sent to a server that holds no images.
 */
const { urlFor } = usePlacedImages()

const placedUrl = (row: Drawn) => urlFor(row.image)

/**
 * How one of somebody's own sheets is drawn — the same three answers a plate
 * gets, out of the same walk of the stack, so a sheet dragged past the
 * lettering paints over it exactly as the lettering dragged under it would.
 */
function sheetStyle (row: Drawn) {
  const filter = filterFor(row.key)

  return {
    opacity: row.opacity,
    zIndex: row.z,
    ...(filter ? { filter } : {}),
  }
}

/* ---------- the repairs ---------- */

/**
 * The cleaned patches for this page, by block — see `useClean`.
 *
 * Read here rather than passed in because the cleaned plate is the canvas's
 * own business, and a patch is a property of the page rather than of
 * whatever asked for the cleaning.
 */
const { patches, patchFor } = useClean()

/**
 * The repairs that still belong to the blocks they were made for.
 *
 * Asked through `patchFor` rather than read straight out of the map: a patch
 * is artwork cut from one rectangle, so transforming a block leaves its
 * repair behind — and a repair drawn over a block it was not cut from covers
 * artwork nobody retouched. `patches` is depended on explicitly so this
 * recomputes when a cleaning lands, and the blocks are walked so it also
 * recomputes when one is moved.
 */
const cleaned = computed(() => {
  const target = props.page

  // Depended on explicitly: `patchFor` reads it, but through a call, which a
  // computed cannot see into.
  if (!patches.value) return {}

  const out: Record<string, PagePatch> = {}

  for (const block of target.blocks) {
    const patch = patchFor(target, block)

    if (patch) out[block.id] = patch
  }

  return out
})

/**
 * Where a patch sits: its own box, not its block's.
 *
 * The two differ by the margin of artwork the inpainter was given to work
 * from, and drawing a patch at its block's box would squeeze that margin
 * back into a smaller rectangle — the repair would be scaled, and the seam
 * it was cropped with would land in the wrong place.
 */
function patchStyle (block: Block) {
  const patch = cleaned.value[block.id]

  if (!patch) return {}

  return { left: `${patch.x}%`, top: `${patch.y}%`, width: `${patch.w}%`, height: `${patch.h}%` }
}

/**
 * Which rows the page engine draws, bottom up — the rest stay elements. See
 * `engineRun`, and `CanvasEngine` for why the scan and its repairs are drawn
 * together at all.
 */
const run = computed(() => engineRun(pile.value, adjusts.value, engineGpu.value !== null))

const ownsArt = computed(() => run.value.keys.has('art'))

/**
 * The rows handed to the page art: the run's, where the engine draws the art,
 * and otherwise none — the one empty list, kept, because a literal `[]` here is
 * a new prop on every render and would draw the page again each time.
 */
const NO_ROWS: RunRow[] = []

const artRows = computed(() => (ownsArt.value ? run.value.rows : NO_ROWS))

/**
 * Whether the page on screen has anything drawn over its scan in the run — a
 * repair or a picture. Such a page never shows its thumbnail while it is
 * decoding: the thumbnail is the original, printed lettering and all, and
 * showing it first is the flash this was built to stop.
 */
const covered = computed(() => run.value.rows.some((row) => row.visible
  && ((row.kind === 'clean' && Object.values(cleaned.value).some(Boolean)) || (row.kind === 'image' && !!row.image && !!urlFor(row.image)))))

/* ---------- the lettering ---------- */

/**
 * The lettering, split by the plate it belongs to.
 *
 * A hidden block sets nothing. That is the whole of what `hidden` means — see
 * the note on it in `Block`, "kept out of the render without being thrown
 * away" — and the words were the one part of the render that went on being
 * drawn: the eye dimmed the box, the cleaner already skipped it, and the line
 * itself stayed on the page. Hiding a block looked like it had done nothing,
 * because the thing you were looking at was the thing it had not touched.
 *
 * Its *box* stays, faded, which is not the same oversight: a block you cannot
 * see and cannot find again is one you cannot bring back.
 *
 * The block being typed into is left out for a plainer reason: the editor draws
 * it, in the same face at the same place, and a plate drawing it as well is two
 * copies of one line a subpixel apart — which reads as the lettering having
 * gone soft rather than as anything being drawn twice.
 */
const lettered = computed(() => {
  const set = props.page.blocks.filter((block) => !block.hidden && block.id !== props.editing?.id)

  return {
    dialogue: set.filter((block) => block.type !== 'sfx'),
    sfx: set.filter((block) => block.type === 'sfx'),
  }
})

/** The block being typed into, while it is still on this page. */
const typing = computed(() => {
  const id = props.editing?.id

  return (id ? props.page.blocks.find((block) => block.id === id) : null) ?? null
})

const { fitOf, faceReady, autoSize } = useLetteringFit()

const { inkOf } = usePaper()

/**
 * How a line is set, in the units the screen wants.
 *
 * The two placement controls have to swap the CSS they are carried by when the
 * writing mode turns, and that is the whole of what was broken here.
 *
 * `text-align` works along the *inline* axis and `align-items` across it, and a
 * vertical writing mode swaps which of those is which: set down the page, the
 * inline axis runs top to bottom and the block axis right to left. Carried
 * straight through, a control labelled "top of the balloon" was moving the
 * lettering sideways — and, because the line filled the cross axis, usually not
 * moving it at all.
 *
 * So the mapping turns with the text and the labels stay literally true: the
 * anchor puts the words at the top, middle or bottom of the balloon in both
 * modes, and the alignment puts them left, centre or right in both. Only
 * `justify` has nowhere to go when the text is vertical — it is an inline-axis
 * idea, and there the inline axis is the one the anchor is using — so it reads
 * as centred rather than pretending to do something.
 */
function setStyle (block: Block): CSSProperties {
  /*
   * Nothing to letter against, or no measured size yet: hidden, not shown as
   * something it is about to stop being.
   *
   * Both used to draw. With no page size the box got none of the styles below
   * and came out in the interface font at 14px; with no fit it was drawn at
   * `estimateSize`'s guess. Either way the next frame corrected it, and on every
   * open and page turn the lettering visibly jumped. A block with no size yet is
   * now simply not shown until it has one — which, with fitting before the
   * render and sizes kept between visits, is usually the same frame.
   *
   * The block being typed into is the exception: it has to show whatever there
   * is, or the caret would vanish mid-word while its face loads.
   */
  if (!props.unit) return { visibility: 'hidden' }

  const scan = dims.value
  const style = styleOf(block)
  const typed = props.editing?.id === block.id
  const fit = fitOf(block)
  const fitted = style.size ?? fit?.size ?? (typed ? autoSize(block, style, scan) : undefined)

  if (fitted === undefined || (!typed && !faceReady(block, style))) return { visibility: 'hidden' }

  // The CSS itself is shared with the page export — see `app/utils/letterCss`.
  return letterSet(
    { style, type: block.type, size: fitted, down: setDown(block), ink: inkOf(block, style), fit },
    props.unit * superOf(block),
  )
}

/**
 * The shape a block's lines wrap into, as markup — or null for the plain box.
 * See `shapeParts`; where the words sit in it is the fit's (`LetterFit.pad`).
 *
 * Not for a line that does not fit (`LetterFit.over`). A shape that cannot hold
 * the words pushes the ones that will not go out past its end, where the frame
 * clips them — a flagged line showed as "O-" and nothing else. In the plain box
 * every word is on the page and only the overflow is cut, which is what the
 * flag is asking somebody to look at.
 */
function partsOf (block: Block): ShapeParts | null {
  const style = styleOf(block)
  const fit = fitOf(block)
  const outline = fit?.over ? null : shapeOutline(shapeFor(style, block), style.points)

  return outline ? shapeParts(outline, setDown(block), fit?.pad ?? 0) : null
}

/** The language being lettered, which hyphenation looks words up in — see `HYPHENATE`. */
const target = useState('workspace-target', () => 'en')

/**
 * The editor's element, for the board: it writes the words into it once when
 * the caret arrives and reads them back on every keystroke — see `focusEditor`
 * there, which says why the element is never bound to the block.
 */
const editor = useTemplateRef<HTMLElement>('editor')

defineExpose({ editor })
</script>

<template>
  <!--
    The adjustment layers' filters — drawn nowhere, referenced by the plates
    they reach. One `feComponentTransfer` per row: the same lookup table on all
    three channels, worked out once in `shared/utils/adjust` so a bake can apply
    the very same numbers per pixel.
  -->
  <svg class="pointer-events-none absolute size-0 overflow-hidden" aria-hidden="true">
    <defs>
      <filter
        v-for="one in adjustFilters"
        :id="one.id"
        :key="one.id"
        color-interpolation-filters="sRGB"
        x="0"
        y="0"
        width="100%"
        height="100%"
      >
        <feComponentTransfer>
          <feFuncR type="table" :tableValues="one.table" />
          <feFuncG type="table" :tableValues="one.table" />
          <feFuncB type="table" :tableValues="one.table" />
        </feComponentTransfer>
      </filter>
    </defs>
  </svg>

  <!--
    The plates. Listed here in the order they usually sit, but stacked by the
    z-index the layer panel gives them rather than by that listing — which is
    what makes dragging a row in the panel a change to the page and not just to
    a list. Each is drawn only where the blocks are, because a block is exactly
    the part of the page any of this touches.
  -->
  <!--
    The scan, and nothing else.

    There used to be a span per block here drawing `block.source` over the
    artwork — the printed lettering, written back on. It made sense when a page
    was invented rather than opened: there was no scan, so the words had to be
    drawn or the plate was blank. With a real scan the printed lettering is
    already in the pixels, and drawing it again put a second, smaller copy of
    every line on top of the first — which is what you see with every other
    plate hidden, and it is not the artwork.

    What was read off the page is the Blocks panel's business, and what it will
    say instead is the Lettering plate's. Neither belongs here: this plate is
    the scan as it arrived, which is the one thing in the stack with no earlier
    version to go back to.
  -->
  <!--
    The art plate is the engine's when the engine's run starts with it — which
    it does unless a reader has arranged the stack otherwise, or an adjustment
    reaches the art on the 2D fallback. Then the plate's opacity, eye and
    adjustments are the engine's to apply, row by row, and the element only
    places it in the pile; see `engineRun`.
  -->
  <div
    v-show="ownsArt || plates.art.visible"
    class="pointer-events-none absolute inset-0"
    :style="ownsArt ? { zIndex: run.z } : plateStyle('art')"
  >
    <CanvasPageArt :page="page" :view="view" :rows="artRows" :stand-in="!covered" />
  </div>

  <!--
    What the repair will paint out. Its own plate, so the stack decides whether
    it shows and how strongly — and so it can be put above or below the repair,
    which is how you tell a mask that covers the lettering from one that misses
    a stroke of it.
  -->
  <div v-show="plates.mask.visible" class="pointer-events-none absolute inset-0" :style="plateStyle('mask')">
    <CanvasMask v-if="page.scan" :page="page" :shown="plates.mask.visible" />
  </div>

  <!--
    The brush that corrects the mask. Above every plate and outside the mask's
    own, because it is a thing to press rather than a thing that paints:
    putting it inside the plate would make correcting a mask impossible
    whenever the mask row was turned off, which is exactly when somebody is
    judging whether it needs correcting.

    The mask row still governs whether it may be corrected at all, and did not
    before: the brush asked only which tool was out, so a locked mask took
    strokes exactly as an unlocked one did. `inkedMask` is the layer engine's
    answer — the row must be the mask, selected, and open — and it deliberately
    does not fall back to anything, because there is nothing else a mask stroke
    could sensibly land on.
  -->
  <CanvasMaskBrush
    v-if="page.scan && tool === 'mask' && inkedMask"
    :page="page"
    :style="{ zIndex: CHROME_Z }"
  />

  <!--
    The brush that hands a piece of the page to a reader. Mounted on the same
    terms as the mask brush and for the same reason — above every plate, so
    what it can reach does not depend on which rows are showing — but with no
    layer condition of its own: it paints nothing that is kept, so there is no
    row it could be refused by. Where the block it produces may land is
    `addBlock`'s question, and it answers out loud.
  -->
  <CanvasRegionBrush
    v-if="page.scan && regioning"
    :page="page"
    :mode="tool === 'translate-region' ? 'translate' : 'read'"
    :style="{ zIndex: CHROME_Z }"
  />

  <div v-show="plates.clean.visible" class="pointer-events-none absolute inset-0" :style="plateStyle('clean')">
    <!--
      The repair, per block: an inpainted patch — real artwork with the
      lettering painted out — drawn where it was cropped from, which is a
      little wider than the block, because the model was given a margin of the
      page to work from and the patch carries it.

      A block with no patch draws nothing. There used to be a flat white fill
      here standing in for a repair, from before there was one to stand in for;
      it survived into a build that can actually clean a page and became a lie
      — a white rectangle over artwork nobody had retouched, on a plate whose
      whole job is to say what *has* been retouched. An uncleaned balloon now
      looks uncleaned.
    -->
    <!--
      No `image-rendering` of its own, deliberately, and that is the whole point
      of the resample in `finishRegion`.

      It had one for a while. A patch used to be stored at `tileSize`, which is a
      different grid from the page's — so under the sheet's `pixelated` it drew
      its own pixels as blocks of a size the artwork around it never had, and
      exempting it drew a soft rectangle in crisp line art instead. Two ways to
      look wrong, both of them the same thing: the patch was not on the page's
      grid.

      It is now, so it wants no exception. Whatever the sheet does to the scan it
      does to the repair, at every zoom, which is the only way the two can meet
      without a seam.
    -->
    <img
      v-for="block in page.blocks"
      v-show="cleaned[block.id] && !run.keys.has('clean')"
      :key="`patch-${block.id}`"
      :src="cleaned[block.id]?.url"
      alt=""
      class="absolute"
      :style="patchStyle(block)"
    >

    <!--
      Hand retouching, over the mock per-block plates: the real cleaned pixels,
      replayed from the stroke log. Inside the clean plate's div so the layer
      panel's eye, opacity and place in the pile govern paint the same as
      everything else on the plate.
    -->
    <CanvasPaint v-if="page.scan" :page="page" :active="painting && inked?.plate === 'clean'" :engine="run.keys.has('clean')" />
  </div>

  <!--
    The lettering as it would land, clipped to the box it has to fit in — which
    is the question the panel beside it exists to answer, so it is worth being
    able to see it on the page as well as read it in a field.

    A plate of its own rather than something drawn inside the block boxes,
    because a plate is a thing the stack can move: put Lettering under the
    cleaned plate and the words go under the repair, which is a thing somebody
    checking a clean will want. Text inside the boxes could only ever sit where
    the boxes sit, which is above everything.

    Until there is a translation it shows what was *read* instead. A block with
    nothing in it is the state a page is in between being read and being
    translated, and an empty box says nothing about whether the reading worked
    — which is exactly the moment somebody wants to look. It is drawn as the
    placeholder it is: italic, and not the weight the real lettering is set in.

    Orange rather than the grey it used to be — see `STANDING_IN_TONE`, which
    the block list wears for the same state. Grey was the wrong signal twice
    over here: the pages are black and white, so grey type over grey art is the
    one colour that does not separate from what is under it, and
    lighter-and-greyer reads as *fading out* when what it means is work still
    to come.

    The lettered half carries no colour of its own at all: that one is not a
    signal, it is ink, and which ink it is depends on what is behind it —
    `setStyle` puts it on the box and the span inherits it. It used to be
    `neutral-900` here, which is dark type on a black balloon, which is a
    translation you cannot read on a page whose original lettering was
    perfectly legible. See `usePaper`.
  -->
  <!--
    Held as the pixels they already have while the view moves: the board marks
    the sheet `data-moving` for the length of a pan or a zoom, and these two
    plates take `will-change` from it.

    Measured on a page zoomed to 5×: panning dropped 15–30 frames in 90 for the
    first second or two, and hiding the Dialogue plate alone made it smooth from
    the first frame — the browser was rasterising the lettering afresh, at five
    times its size, for every part of the page a pan uncovered. `will-change`
    promotes the plate to a layer the compositor moves rather than repaints, and
    it comes off when the view settles, so the text is drawn sharp at its new
    size once there is time to. The cost is that a zoom shows the lettering at
    the size it was held at until then — soft for a moment, never misplaced.

    Only while moving, deliberately: left on, the lettering would stay at
    whatever size it was first held at — see `pixelPeek` on why nothing here is
    promoted for good. And by a selector rather than a prop, because a prop that
    changed at the start and the end of every gesture would render this whole
    component twice a gesture, at the start of it — the one frame a pan is
    judged by.
  -->
  <div
    v-show="plates.sfx.visible"
    class="pointer-events-none absolute inset-0 group-data-moving/sheet:will-change-transform"
    :style="plateStyle('sfx')"
  >
    <div
      v-for="block in lettered.sfx"
      :key="`set-${block.id}`"
      class="absolute flex overflow-hidden"
      :style="[textStyle(block), setStyle(block)]"
      :lang="block.translation ? target : undefined"
    >
      <CanvasLetterWords
        :class="block.translation ? undefined : [STANDING_IN_TONE, 'italic']"
        :text="block.translation || block.source"
        :parts="partsOf(block)"
      />
    </div>
  </div>

  <div
    v-show="plates.dialogue.visible"
    class="pointer-events-none absolute inset-0 group-data-moving/sheet:will-change-transform"
    :style="plateStyle('dialogue')"
  >
    <div
      v-for="block in lettered.dialogue"
      :key="`set-${block.id}`"
      class="absolute flex overflow-hidden"
      :style="[textStyle(block), setStyle(block)]"
      :lang="block.translation ? target : undefined"
    >
      <CanvasLetterWords
        :class="block.translation ? undefined : [STANDING_IN_TONE, 'italic']"
        :text="block.translation || block.source"
        :parts="partsOf(block)"
      />
    </div>
  </div>

  <!--
    The words being typed, in place on the page.

    The same box the lettering plate would draw them in, wearing the same two
    style objects, so that letting go of the caret changes nothing about how the
    line looks — the plate leaves this block out while it is being typed (see
    `lettered`) and takes it back afterwards, and the swap is meant to be
    invisible.

    Above the plates rather than on one, at `CHROME_Z`, because it is a thing to
    type into rather than a thing that prints: on the lettering plate it would
    be dimmed by that plate's opacity slider and hidden with its eye, and a
    letterer who turned the lettering off to look at the art would lose the
    caret they were using.

    Only the words themselves take the pointer. The box around them is the whole
    balloon, and a press anywhere in it that meant "type here" would swallow
    presses meant for the page behind.
  -->
  <div
    v-if="typing"
    class="pointer-events-none absolute flex"
    :class="editing?.grows ? 'overflow-visible' : 'overflow-hidden'"
    :style="[textStyle(typing), setStyle(typing), { zIndex: CHROME_Z }]"
    :lang="target"
  >
    <!--
      Always the plain line, never the shape, even for a shaped block. The first
      character typed into an untranslated block turns it from box to shape
      (`shapeFor`), and swapping the element being typed into mid-keystroke would
      drop the words the board wrote into it once. The size is the shaped fit's,
      which is never larger than the box would take, so the words fit while
      typing and move into their shape when the caret leaves.

      `plaintext-only`, because a block holds a string: paste a styled paragraph
      into a rich contenteditable and the markup is real to the browser and
      invisible to everything downstream of it.

      While the box grows with the words it is the words that decide their own
      size — `max-content` along whichever axis the line is written on, and no
      shrinking, or the flex box would squeeze the span back to the box it is
      supposed to be measuring.
    -->
    <span
      ref="editor"
      data-lettering
      contenteditable="plaintext-only"
      class="outline-primary/70 pointer-events-auto outline-1 outline-dashed select-text"
      :style="[LINE_BOX, editing?.grows ? { inlineSize: 'max-content', flex: 'none' } : {}]"
      @input="emit('type')"
      @blur="emit('blur')"
      @keydown.stop="emit('keys', $event)"
      @pointerdown.stop
    />
  </div>

  <!--
    The blank sheets, each its own canvas at its own height in the pile.

    Outside the plates rather than inside one, because that is what makes it a
    layer rather than a decoration: the stack decides where it paints, so a
    sheet can sit under the repair, over the lettering, or between them, and the
    eye and opacity beside its name govern it like anything else. Its marks are
    its own — a surface keyed by the row — so nothing it holds can be confused
    with the retouching.
  -->
  <div
    v-for="row in sheets"
    v-show="row.visible"
    :key="row.layer"
    class="pointer-events-none absolute inset-0"
    :style="sheetStyle(row)"
  >
    <CanvasPaint
      v-if="page.scan"
      :page="page"
      :surface="row.layer"
      :active="painting && inked?.layer === row.layer"
      :engine="run.keys.has(row.key)"
    />
  </div>

  <!--
    The pictures somebody has placed, each at its own height in the pile.

    The same shape as the sheets above and for the same reason — the stack
    decides where it draws — but it holds a file rather than a canvas, so there
    is nothing to paint on and nothing to arm. A clean raw is what this was
    built for; the stack has no opinion about that, and neither does this.

    `object-contain` and the classes the scan is drawn with, so a picture the
    same shape as the page fills it exactly and one that is not is letterboxed
    rather than stretched. Placing a clean of the wrong shape is then something
    you can *see* — a band down one side — instead of a page subtly the wrong
    width with every letter landing short.

    Nothing is drawn while the bytes are still being found. A reference whose
    file this browser does not hold is the ordinary state of a chapter somebody
    shared, and an empty `src` would ask the page for a request that cannot be
    made.
  -->
  <div
    v-for="row in placed"
    v-show="row.visible && !run.keys.has(row.key)"
    :key="row.layer"
    class="pointer-events-none absolute inset-0"
    :style="sheetStyle(row)"
  >
    <img
      v-if="placedUrl(row)"
      :src="placedUrl(row)!"
      alt=""
      class="size-full object-contain"
    >
  </div>

  <!--
    The blocks, over the art rather than in it: they are what was found on the
    page, not part of it, and everything about them — where they are, what they
    say, whether they are still there — can change without the page underneath
    being touched.

    Above every plate, at `CHROME_Z`, and deliberately outside the stack: these
    are how you get at the page rather than part of the picture, and a layer
    panel that could bury its own handles would be one you could lock yourself
    out of with a drag.

    A block's own layer still governs it, though, and the two halves of that
    part company. Hide the layer and the box goes with it — there is nothing on
    the page to have a handle onto. Lock it and the box stays, faded and inert:
    a lock is the reader saying *not this one*, and the whole use of it is going
    on seeing what you are not editing.

    And it draws nothing at all. A page of a dozen balloons is a page of a dozen
    boxes, and boxes drawn over lettering are the one thing standing between a
    letterer and the thing they are judging — how the words sit on the art. So
    the box is only the hit area: what it looks like — the tint under the
    pointer, the firmer one once picked, the edges — is all drawn by the board's
    chrome overlay from the same geometry, so none of it can sit half a pixel
    off the rest. See `blockChrome` there.
  -->
  <button
    v-for="(block, index) in page.blocks"
    v-show="blockShown(block)"
    :key="block.id"
    type="button"
    :data-block="block.id"
    class="absolute"
    :class="[
      (stroking || !blockPickable(block)) && 'pointer-events-none',
      gripped && 'cursor-move',
      texting && 'cursor-text',
    ]"
    :style="blockStyle(block)"
    :aria-label="`Block ${index + 1}, ${block.type}`"
    :aria-pressed="selection.includes(block.id)"
    :aria-disabled="!blockPickable(block)"
    :tabindex="stroking || !blockPickable(block) ? -1 : 0"
    @pointerenter="emit('hover', block.id, true)"
    @pointerleave="emit('hover', block.id, false)"
    @pointerdown="emit('press', block, $event)"
    @click="emit('pick', block.id, $event)"
  />
</template>
