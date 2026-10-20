<script setup lang="ts">
import { core, falloff, maskCore, reach } from '~/utils/paint/stamps'

/**
 * The brush, shown where it would land.
 *
 * Two circles, because a soft brush has two edges and only showing one of them
 * is how it comes to be aimed by guesswork:
 *
 * - a **solid** ring at the nominal diameter, which is now exactly where the
 *   mark ends — nothing is laid past it at any hardness;
 * - a **dashed** ring at `core`, where full strength stops and the fade starts.
 *   That is the one thing hardness moves, and the pair of rings is the only
 *   place a reader can see it before pressing.
 *
 * The dashed one used to sit *outside* the solid one, back when a soft mark
 * spilled past its own ring. It does not any more, so it moved inside rather
 * than being deleted: the question it answers — how much of this is solid —
 * is the same question, asked of a shape that keeps its paint inside its edge.
 * It hides itself at either extreme, where it would be a circle drawn on top of
 * the ring or a dot at the centre.
 *
 * And, for the brush, the mark itself between them — see `paint`.
 *
 * ## Why it is here and not in the brushes
 *
 * It has to be above the whole stack. The paint canvas lives *inside* the
 * cleaned plate, so a ring drawn alongside it would be faded by that plate's
 * opacity — a cursor at fifty-five per cent, changing as somebody moved a
 * slider that has nothing to do with cursors. Drawn once at chrome height it
 * is the same cursor whatever the layer panel is set to, and both brushes get
 * it without either of them owning it.
 *
 * ## Screen pixels, not page pixels
 *
 * And it is drawn *outside* the stage, with the grips and the outlines, which
 * is why it takes an origin as well as a scale: page coordinates mean nothing
 * out here until the stage's transform has been done as arithmetic. Inside the
 * stage the ring was a page-space box wearing the zoom, and a cursor cannot
 * survive that — a border is held at a whole pixel of the space it is laid out
 * in, so the outline thickened with the zoom and, being drawn inwards from the
 * box's own edge, took the ring's diameter with it. See `toScreen` in `Board`.
 */
const props = defineProps<{
  /** Screen pixels per page pixel — the sheet's scale with the zoom in it. */
  scale: number
  /** The sheet's top left corner in the viewport, which page pixels are from. */
  origin: { x: number, y: number }
  /** Faded, for a brush that is refusing strokes while something else runs. */
  busy?: boolean
}>()

/**
 * How many stops the preview's fade is drawn with.
 *
 * Fewer than the canvas uses, and deliberately: this is a hint a pointer's
 * width across, where the error between a twelve-segment curve and the curve
 * itself is nowhere near a level of alpha. The canvas gradient is the one that
 * has to be exact.
 */
const FADE_STOPS = 12

const { at } = useBrushCursor()
const { size, softness, colour } = usePaintSettings()
const { tool } = useTools()
const { picking, sheet, armed, aim } = useCloneStamp()

/**
 * Alt, watched here because here is the only place that draws a cursor.
 *
 * One listener pair for the app rather than one per brush: this element is
 * rendered once, by the board, above everything. `window` rather than the
 * canvas because a modifier held while the pointer is anywhere is still held —
 * a key listener on the page would miss alt pressed before the pointer arrived,
 * which is the ordinary way somebody picks a source.
 *
 * `event.altKey` rather than the key name, so the option key on a Mac and alt
 * elsewhere are the same question, and so a window that loses focus mid-press
 * settles back to false the moment anything else is pressed.
 */
/**
 * Alt with the brush, which lifts the colour under the pointer.
 *
 * Kept apart from the stamp's `picking` rather than folded into it: that one is
 * shared state about a *source*, which the clone goes on using after the key is
 * let go, and this is only ever about what the next press would do. They draw
 * the same mark because they are the same act — take what is at this point,
 * lay nothing down.
 */
const lifting = ref(false)

if (import.meta.client) {
  const read = (event: KeyboardEvent) => {
    picking.value = event.altKey && tool.value === 'clone'
    lifting.value = event.altKey && tool.value === 'brush'
  }

  useEventListener(window, 'keydown', read)
  useEventListener(window, 'keyup', read)
  // Alt-tabbing away leaves the key down as far as this window ever hears, and
  // a cursor stuck in the picking state is one that lies about what a click does.
  useEventListener(window, 'blur', () => {
    picking.value = false
    lifting.value = false
  })
}

const { adjusting } = useBrushGesture()

/**
 * The next press takes rather than lays.
 *
 * Three ways to be in that state and only two of them were listed. Alt over the
 * clone stamp picks a source and alt over the brush lifts a colour — both
 * modifiers, both temporary — and the **colour picker** is the tool that does
 * nothing else. It needs no modifier because sampling is the whole of what it
 * is, which is exactly why it was missed: everything here was written in terms
 * of a key being held, and the picker holds nothing.
 *
 * So the picker drew the brush's rings, sized and feathered, over a tool that
 * reads a single pixel and lays no paint at all. A ring means "this much is
 * about to be covered", and pointing one at a pipette is the cursor describing
 * a gesture that cannot happen.
 *
 * Not while the brush is being set, though. Alt is named in that gesture's
 * tooltip as well, so holding it to size the brush swapped the rings — the only
 * thing that shows what is being set — for a pipette's target, and the setting
 * could be watched in the bar or on the page but not on the thing it describes.
 * The drag is the more specific answer to the same modifier, so it wins.
 */
const sampling = computed(() => !adjusting.value && (
  tool.value === 'picker' || picking.value || lifting.value
))

/** The stamp is out and has something to copy from, so show what that is. */
const cloning = computed(() => tool.value === 'clone' && armed.value && Boolean(sheet.value))

/** Where the copy is being taken from, for a pointer where it is now. */
const from = computed(() => (at.value ? aim(at.value) : null))

/**
 * Centred on a point given in page pixels, and put there by a transform rather
 * than by `left`/`top`.
 *
 * The box keeps one position and one size and only its transform changes, so a
 * pointer move is a composited shift rather than a fresh layout of an element
 * that sits above every plate on the page. Which matters here more than
 * anywhere: this moves on every single pointer event, and it is the thing whose
 * lag somebody would read as the brush lagging.
 */
function place (x: number, y: number, wide: number) {
  return {
    left: '0px',
    top: '0px',
    transform: `translate(${props.origin.x + x - wide / 2}px, ${props.origin.y + y - wide / 2}px)`,
  }
}

/**
 * A circle of `across` page pixels under the pointer, as CSS.
 *
 * The floor is four *screen* pixels, which is the only place it means anything:
 * it is there so that a two-pixel brush is still something you can see and aim,
 * and applied in page pixels it would instead have been four page pixels — a
 * ring that grew with the zoom until it described an area many times the mark.
 */
function circle (across: number) {
  if (!at.value || !props.scale) return null

  const wide = Math.max(4, across * props.scale)

  return {
    ...place(at.value.x * props.scale, at.value.y * props.scale, wide),
    width: `${wide}px`,
    height: `${wide}px`,
  }
}

const ring = computed(() => circle(size.value))

/**
 * Where full strength ends, when there is room to say so.
 *
 * Asked of whichever brush is out, because the two anchor the same fade
 * differently: a mask centres it on the nominal radius so the half-coverage
 * line — which is the mask's real edge, once it is thresholded for the model —
 * lands on the ring, while paint fades inward from the ring because paint has
 * no threshold to land anywhere. See `maskCore`. The solid ring means the same
 * thing for both, and is the one a hand aims with.
 *
 * Both tests are in screen pixels rather than in hardness, which is the only
 * place either question means anything: these are shares of a radius, so a
 * small brush puts the two circles a fraction of a pixel apart at settings
 * where a large one has them well clear. Near the crisp end the inner ring
 * would be drawn on top of the outer one; near the soft end it collapses to a
 * dot at the centre. Both read as a fault rather than as information, so
 * neither is drawn.
 */
const full = computed(() => {
  const across = tool.value === 'mask'
    ? maskCore(size.value, softness.value)
    : core(size.value, softness.value)
  const inner = (across / 2) * props.scale
  const gap = ((size.value - across) / 2) * props.scale

  return inner >= 3 && gap >= 3 ? circle(across) : null
})

/**
 * The mark itself, under the rings: the paint colour, faded out where the
 * brush's own falloff fades it.
 *
 * The rings say where the paint lands and where it stops being solid. Neither
 * says what will actually be *there*, and at any real softness those are
 * different questions — most of a soft mark is nearly transparent, so the
 * colour that arrives is not the one the swatch in the bar shows, and a repair
 * painted to match the paper beside it is judged on exactly that difference.
 *
 * Measured from `reach` and branching at the same threshold as `paintDisc`, so
 * this cannot come to describe a different brush from the one that paints: a
 * preview that is merely nearly right is worse than none, because it is
 * believed.
 *
 * At the paint's own strength, which was tried the other way first. Half
 * strength kept the page legible through the disc and looked reasonable, and it
 * was wrong for the thing this is for: what a mark will *be* is the question
 * being asked, and answering it at half is answering a different one — a colour
 * matched against the paper through a fifty per cent veil is not the colour that
 * lands. Aiming is not given up for it either: the rings sit over this, drawn
 * black against white so that one of the two shows whatever is underneath.
 *
 * Both stops carry the colour and only the alpha falls. That is the same fix
 * `paintDisc` carries, and for the same reason — fading to `transparent`
 * interpolates through transparent *black* and hangs a grey fringe on the
 * whole edge.
 *
 * The brush alone. The eraser takes paint away rather than putting it down, the
 * clone stamp has the source disc for this and brings its own pixels anyway,
 * and the healing brush works its colour out from the page as it goes — there
 * is nothing here that could honestly stand for any of them.
 */
const paint = computed(() => {
  if (tool.value !== 'brush') return null

  const soft = Math.max(0, softness.value)
  const out = reach(size.value, soft)
  const box = circle(out)

  if (!box) return null

  const [r, g, b] = rgbOf(colour.value)
  const ink = (a: number) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(4)})`
  // The gradient's own radius is the disc's, so both radii are shares of it.
  const solid = (core(size.value, soft) / out) * 100
  const stops = [`${ink(1)} 0 ${solid.toFixed(2)}%`]

  if (soft >= 0.02) {
    // The same curve `feather` lays into the canvas gradient, over the same
    // band — walked here rather than approximated, so what the ring promises
    // and what the brush leaves are one description in two languages.
    for (let i = 1; i <= FADE_STOPS; i++) {
      const t = i / FADE_STOPS

      stops.push(`${ink(falloff(t))} ${(solid + (100 - solid) * t).toFixed(2)}%`)
    }
  }

  return {
    ...box,
    background: `radial-gradient(circle closest-side, ${stops.join(', ')})`,
  }
})

/**
 * The page, positioned so the source sits under the middle of the ring.
 *
 * A background rather than a canvas, so the browser does the cutting: the disc
 * is `rounded-full` and `overflow-hidden`, the image behind it is the whole
 * scan at the scale it is being looked at, and moving the pointer is one changed
 * `background-position`. No pixels are read on this side at all, which is what
 * makes this affordable on every pointer move.
 */
const source = computed(() => {
  if (!cloning.value || !from.value || !ring.value || !sheet.value || !props.scale) return null

  const wide = Math.max(4, size.value * props.scale)

  return {
    ...ring.value,
    backgroundImage: `url(${sheet.value.url})`,
    backgroundSize: `${sheet.value.width * props.scale}px ${sheet.value.height * props.scale}px`,
    backgroundPosition: `${-(from.value.x * props.scale - wide / 2)}px ${-(from.value.y * props.scale - wide / 2)}px`,
  }
})

/**
 * A mark on the place being copied *from*, as well as the preview.
 *
 * The preview says what is there; this says where it is. Both are wanted, and
 * for different halves of the job — lining a patch up against its neighbour
 * needs the pixels, and knowing you are about to run off the edge of the panel
 * you are borrowing from needs the position.
 */
const marker = computed(() => {
  if (!cloning.value || !from.value || !props.scale) return null

  return place(from.value.x * props.scale, from.value.y * props.scale, 12)
})

/** The next press takes a source or a colour, and lays nothing. */
const pick = computed(() => {
  if (!sampling.value || !at.value || !props.scale) return null

  return place(at.value.x * props.scale, at.value.y * props.scale, 18)
})
</script>

<template>
  <!--
    The next press takes rather than lays — a clone source, the colour under
    the brush, or whatever the picker is pointed at — so the cursor stops being
    a brush and becomes a target.

    Instead of the rings rather than beside them. A ring means "paint lands
    here", and leaving it up would be the cursor describing something the click
    will not do — which is worse than no cursor, because it is confidently
    wrong. The size is fixed: what is taken is a point, not an area, and
    scaling this with the brush would imply otherwise. That last part is why
    the picker looked wrong even at a glance: a pipette reads one pixel and was
    wearing a forty-pixel feathered ring.
  -->
  <div v-if="pick" class="pointer-events-none absolute size-[18px]" :style="pick">
    <div class="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-black/80" />
    <div class="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-black/80" />
    <div class="absolute inset-[3px] rounded-full border border-white/90" />
    <div class="absolute inset-[4px] rounded-full border border-black/80" />
  </div>

  <template v-else>
    <!--
      What the brush would leave, where it would leave it. Bottom of the pile:
      it stands for the paint, and the rings over it are the cursor — an outline
      lost inside its own preview is one you cannot aim.

      Clipped, and it has to be. A gradient's last colour does not stop at the
      ending shape — it floods the rest of the box — so it is only the fade
      running to nothing that keeps the corners clear. At full hardness there is
      no fade: the single stop is opaque all the way out, and the preview came
      out as a filled square. The clip is the same box the gradient is sized to,
      so the two cannot disagree about where the mark ends.
    -->
    <div
      v-if="paint"
      class="pointer-events-none absolute rounded-full"
      :class="busy && 'opacity-30'"
      :style="paint"
    />

    <!--
      What is under the source, shown where the mark will go — so a repair can
      be lined up against its neighbour before a single pixel is laid down.
      Under the rings, which draw the edge of it.
    -->
    <div
      v-if="source"
      class="pointer-events-none absolute overflow-hidden rounded-full opacity-80"
      :class="busy && 'opacity-30'"
      :style="source"
    />

    <!--
      And where that came from. Small, and drawn in the same black-on-white pair
      the rings use, for the reason given below: one of the two always contrasts.
    -->
    <div v-if="marker" class="pointer-events-none absolute size-3" :style="marker">
      <div class="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/90" />
      <div class="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/90" />
      <div class="absolute inset-0 rounded-full border border-black/60" />
    </div>

    <!--
      Dashed where full strength ends, so it reads as the start of a falloff
      rather than as a second brush size, and under the solid ring — they close
      on each other as the brush is hardened, and the edge of the mark should
      win that overlap.
    -->
    <div
      v-if="full"
      class="pointer-events-none absolute rounded-full border border-dashed border-black/50"
      :class="busy && 'opacity-30'"
      :style="full"
    >
      <div class="absolute inset-px rounded-full border border-dashed border-white/70" />
    </div>

    <!--
      Two rings, not a blend mode. `mix-blend-difference` reads well until the
      element lands in a stacking context of its own — which a z-indexed cursor
      over a transformed page always does — and then it quietly stops inverting
      anything. A black ring with a white one just inside it is the cursor every
      editor draws, and it is legible on white paper, black panels and screentone
      alike because one of the two always contrasts.
    -->
    <div
      v-if="ring"
      class="pointer-events-none absolute rounded-full border border-black/80"
      :class="busy && 'opacity-30'"
      :style="ring"
    >
      <div class="absolute inset-px rounded-full border border-white/90" />
    </div>
  </template>
</template>
