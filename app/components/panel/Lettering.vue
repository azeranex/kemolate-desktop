<script setup lang="ts">
/**
 * How the selected lettering is set: the face, where it sits in its balloon, and
 * the four numbers.
 *
 * It edits the whole selection rather than one block, because that is how the
 * work is actually done — a page is lettered by picking every balloon and
 * setting them alike, and a panel that insisted on one at a time would make the
 * common case the slow one. Where the selection disagrees the row says so
 * instead of showing the first block's answer as though it were everyone's.
 *
 * The type row changes what a block *is*, not merely how it looks, and so moves
 * it between layers — sound effects are lettered on their own plate. It is here
 * because it is the first thing you decide about a line and the thing every
 * setting below reads differently for.
 *
 * Sizes are in the scan's own pixels, which is the only unit that holds still —
 * see `shared/utils/lettering`.
 */
import {
  AlignCenterIcon,
  AlignHorizontalJustifyCenterIcon,
  AlignHorizontalJustifyEndIcon,
  AlignHorizontalJustifyStartIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CircleAlertIcon,
  ItalicIcon,
  ScanIcon,
  ShrinkIcon,
  UnderlineIcon,
  Undo2Icon,
  WandSparklesIcon,
} from '@lucide/vue'

import type { LetterShape } from '#shared/utils/lettering'

// By hand, so a dev server already running picks the new exports up.
import { customFrom, shapeFor, shapeOutline, SQUEEZE_FLOOR, standardApplies } from '#shared/utils/lettering'
import { useLetteringStandard } from '~/composables/useLetteringStandard'
import { AnchorBottomIcon, AnchorMiddleIcon, AnchorTopIcon } from '~/utils/anchorIcons'
import { fitSize, inkSize } from '~/utils/lettering'

const {
  page, selected, lettering, setLettering, resetLettering, setDown, styleOf, updateMany,
  framing, resetFrame,
} = useComic()
const { autoSize, fitOf } = useLetteringFit()
const { standard, set: setStandard } = useLetteringStandard()
const { shortenBlock, running: translating } = useTranslate()
const { translate: translateSettings } = useComic()

/** The language being lettered, which hyphenation looks words up in. */
const target = useState('workspace-target', () => 'en')

/**
 * How many of the selected blocks have been given a frame of their own.
 *
 * A count rather than a flag because this panel edits the whole selection, and
 * the difference between "this balloon" and "four of them" is the difference
 * between a button somebody presses and one they think twice about.
 */
const framed = computed(() => selected.value.filter((block) => block.letter).length)

const style = computed(() => lettering.value.value)

const mixed = (key: keyof Lettering) => lettering.value.mixed.has(key)

/**
 * The scan's own size, which is what every number here is measured in. Nought
 * until the file has been looked at, and the rows that need it say so rather
 * than quoting pixels of a page nothing has measured.
 */
const scan = computed(() => {
  const found = page.value?.scan

  return found?.width && found.height ? { w: found.width, h: found.height } : null
})

/**
 * How far the dials go on this page — they are scan pixels, so a big scan needs
 * a longer track (`letteringRange`). From the page's recorded size, so a page
 * whose picture is not here still offers the range it will be lettered in.
 */
const range = computed(() => letteringRange(page.value ? pageSize(page.value).width : undefined))

/**
 * One selected block's balloon in scan pixels — what Fit measures against.
 *
 * The lettering frame, not the block's own box. They are the same thing until
 * somebody widens a balloon to take the English, and from then on the block's
 * box is the rectangle the repair was cut from and the frame is the room the
 * words have — see `Block.letter`. Fitting to the first of those would set the
 * translation to the size of the line it replaced, which is the one thing
 * resizing a balloon is done to prevent.
 */
function balloon (block: Block) {
  const size = scan.value
  const box = letterBoxOf(block)

  return size ? { w: (box.w / 100) * size.w, h: (box.h / 100) * size.h } : null
}

/**
 * Where the Size slider sits while nothing has been chosen: at the size the page
 * is actually being set in — the measured fit, from the same map the canvas
 * draws from. A slider parked at its minimum under a readout saying "Auto" would
 * be describing a third thing that is true nowhere.
 */
const sizeAt = computed(() => {
  if (style.value.size !== null) return style.value.size

  const first = selected.value[0]
  const found = first && page.value?.scan

  return found
    ? autoSize(first, style.value, page.value!.scan!)
    : (range.value.size.min + range.value.size.max) / 2
})

const lineAt = computed(() => style.value.line ?? AUTO_LINE)

/**
 * What the H/V pair is saying when neither of them is down, so the reader can
 * tell "nobody has chosen" from "somebody chose across".
 */
const reading = computed(() => {
  if (style.value.vertical !== null) return 'Press again to let the block decide'

  const first = selected.value[0]

  if (!first) return ''

  const down = setDown(first)

  return first.translation.trim()
    ? 'Following the block — across, because it has been translated'
    : `Following the block — ${down ? 'down' : 'across'}, the way it was read`
})

/** The one type the selection is, or null where it is several. */
const kind = computed(() => {
  const first = selected.value[0]?.type ?? null

  return selected.value.every((block) => block.type === first) ? first : null
})

function setKind (next: string) {
  // One step for the selection, however many it is — see `BlocksEntry`.
  updateMany(selected.value.map((block) => ({ id: block.id, patch: { type: next as BlockType } })))
}

/**
 * The face, with the way back to letting the block decide kept as an option in
 * the same menu rather than as a button beside it.
 *
 * The dials below hand Auto back through their readout, which works because a
 * slider has a readout to hang it on. A select has no such spare surface, and a
 * second control next to it would be a second thing to explain — so Auto is a
 * row in the menu, the way the H/V pair already uses "neither pressed".
 *
 * A name rather than the empty string, which reka-ui reserves for "nothing is
 * selected" and refuses to let an item carry — and which this menu needs for
 * the mixed selection anyway. It is not a `FontKey` and never reaches a block:
 * `setFont` turns it back into the null that means "let the block decide".
 */
const AUTO_FACE = 'auto'

/**
 * Which face Auto currently means — the first block's, since a selection of one
 * kind is the case worth naming and a mixed one has no single answer to give.
 * Named rather than left to be discovered, because "Auto" on its own does not
 * say whether the page is about to be set in Anime Ace or in Bangers.
 */
const autoFace = computed(() => {
  const first = selected.value[0]

  return first ? FONTS_BY_KEY.get(faceOf(null, first.type)) : undefined
})

/** The face somebody chose, where they did — null being Auto rather than none. */
const chosen = computed(() => (style.value.font ? FONTS_BY_KEY.get(style.value.font) : undefined))

const following = computed(() =>
  autoFace.value ? `Following the block — ${autoFace.value.note}` : '')

function setFont (next: string) {
  setLettering({ font: next && next !== AUTO_FACE ? (next as FontKey) : null })
}

/**
 * Fit every selected line to its own balloon — each measured separately,
 * because they are different words in different shapes and one size for the lot
 * is exactly what Fit exists instead of.
 *
 * Nothing to measure against without the scan's real size, so the button is off
 * until the file has been read rather than quietly writing sizes worked out from
 * a page it is guessing the shape of.
 */
function fit () {
  const patches = selected.value.flatMap((block) => {
    const input = inputOf(block)

    if (!input) return []

    const { size } = fitSize(input, range.value.size)

    return [{ id: block.id, patch: { style: { ...block.style, size } } }]
  })

  // Through the timeline, as one step. It used to write `block.style` straight
  // on, so a Fit could not be taken back at all.
  updateMany(patches)
}

/**
 * What measuring one block takes — its words, its frame, and how it is set.
 *
 * Each block's own setting, not the selection's. `style` is the first block's,
 * so every balloon in a mixed selection was once measured with that one's line,
 * spacing and weight — a size fitted for somebody else's text. Each block's own
 * direction and face as well: a page part-translated has some balloons still
 * running down it and some already across, and a selection can hold a balloon
 * and a sound effect. And its shape, which is as much of the room as the frame.
 */
function inputOf (block: Block) {
  const box = balloon(block)

  if (!box) return null

  const own = styleOf(block)

  return {
    text: block.translation || block.source,
    box,
    line: own.line ?? AUTO_LINE,
    spacing: own.spacing,
    bold: own.bold,
    italic: own.italic,
    vertical: setDown(block),
    family: fontStack(faceOf(own.font, block.type)),
    shape: shapeOutline(shapeFor(own, block), own.points),
    anchor: own.anchor,
    lang: target.value,
  }
}

/**
 * The other way round from `fit`: the frame brought to the words, at the size
 * they are already set at, and the words left exactly where they are.
 *
 * For tidying up after the fact — a frame dragged out generously while the
 * English was being written, now three times the size of what is in it and
 * catching every click near the balloon. The words have to stay put, so the
 * frame keeps whichever edge they are set against: the left edge for text
 * aligned left, the right for right, the centre for centred, and the same for
 * top, middle and bottom. That holds down the page as well, where the anchor
 * still means top and bottom and the alignment left and right — see
 * `letterSet`. On a turned frame the edges are its own, so the shift is made
 * along its axes and turned onto the page.
 *
 * Only a translated block: the words measured are the ones lettered, and an
 * untranslated block has none. The lettering frame, never the block's own box,
 * which is what the reading and the repair were cut from. A size on Auto stays
 * on Auto; the frame is a pixel over the ink, and the next fit finds the same
 * size in it.
 */
function fitFrame () {
  const measured = scan.value
  const here = page.value?.scan

  if (!measured || !here) return

  const space = { width: measured.w, height: measured.h }

  const patches = selected.value.flatMap((block) => {
    if (!block.translation.trim()) return []

    const own = styleOf(block)
    const frame = toOriented(letterBoxOf(block), space)
    const vertical = setDown(block)
    const ink = inkSize({
      text: block.translation,
      box: { w: frame.w, h: frame.h },
      line: own.line ?? AUTO_LINE,
      spacing: own.spacing,
      bold: own.bold,
      italic: own.italic,
      vertical,
      family: fontStack(faceOf(own.font, block.type)),
    }, own.size ?? autoSize(block, own, here))

    if (!ink.w || !ink.h) return []

    const w = Math.ceil(ink.w) + 1
    const h = Math.ceil(ink.h) + 1

    // Which edge the words are set against, -1 for the start and 1 for the
    // end. Justified text runs to both, and keeps its left; down the page it
    // reads as centred, and keeps its middle.
    const across = own.align === 'left' ? -1 : own.align === 'right' ? 1 : own.align === 'justify' && !vertical ? -1 : 0
    const along = own.anchor === 'top' ? -1 : own.anchor === 'bottom' ? 1 : 0
    const shift = mapped(matrixOf(frame), (across * (frame.w - w)) / 2, (along * (frame.h - h)) / 2)
    const next = { ...frame, w, h, cx: frame.cx + shift.x, cy: frame.cy + shift.y }

    return [{ id: block.id, patch: { letter: toBoxed(next, space) as LetterBox } }]
  })

  // One step for the selection, like `fit`.
  updateMany(patches)
}

/** Whether any selected block has words to bring a frame to. */
const canFitFrame = computed(() => Boolean(scan.value) && selected.value.some((block) => block.translation.trim()))

/** The three marks, as one list so the row is a loop rather than three copies. */
const MARKS = [
  { key: 'bold', label: 'Bold', icon: BoldIcon },
  { key: 'italic', label: 'Italic', icon: ItalicIcon },
  { key: 'underline', label: 'Underline', icon: UnderlineIcon },
] as const

/**
 * Whether the selection is being set down the page, for the sake of the icons
 * below. Only when they all are: a mixed selection has no one direction, and an
 * icon that is true of half of it is worse than the ordinary one.
 */
const down = computed(() => selected.value.length > 0 && selected.value.every(setDown))

/*
 * The alignment glyphs, in the direction the text is actually running.
 *
 * Lucide draws these as bars against a guide, and the bars have an orientation:
 * `align-vertical-justify-*` are wide bars, which read as lines of horizontal
 * text, while `align-*-horizontal` are tall bars, which read as columns. The
 * pair for each control is therefore the same guide with the bars turned — the
 * button means the same thing either way, and looks like the thing it will do.
 *
 * Tabler's `align-box-*` set says more — it draws the words inside the balloon
 * rather than as bars beside a line — and was tried here and taken back out: a
 * box outline plus two-pixel strokes is too heavy at the size these are drawn.
 * Saying less, lightly, wins.
 *
 * The anchor row does not turn with the text. Its glyphs are the alignment
 * row's text strokes transposed — see `utils/anchorIcons`, which says why they
 * had to be drawn — and strokes that hang from the top read the same whether
 * they stand for lines of English or columns of Japanese.
 *
 * "Align text left" rather than "Align left", because the Align panel already
 * has a button by that name — it aligns the *boxes* against each other, this
 * aligns the words inside one. Two controls with the same name in one document
 * are two controls a screen reader cannot tell apart.
 */
const ALIGNS = computed(() => [
  {
    key: 'left',
    label: 'Align text left',
    icon: down.value ? AlignHorizontalJustifyStartIcon : AlignLeftIcon,
  },
  {
    key: 'center',
    label: 'Align text centre',
    icon: down.value ? AlignHorizontalJustifyCenterIcon : AlignCenterIcon,
  },
  {
    key: 'right',
    label: 'Align text right',
    icon: down.value ? AlignHorizontalJustifyEndIcon : AlignRightIcon,
  },
  {
    key: 'justify',
    label: 'Justify text',
    icon: AlignJustifyIcon,
    // Justification is an inline-axis idea, and down the page that axis is the
    // anchor's. Off rather than quietly doing nothing.
    off: down.value,
  },
] as const)

const ANCHORS = [
  {
    key: 'top',
    label: 'Text to the top of the balloon',
    icon: AnchorTopIcon,
  },
  {
    key: 'middle',
    label: 'Text to the middle of the balloon',
    icon: AnchorMiddleIcon,
  },
  {
    key: 'bottom',
    label: 'Text to the bottom of the balloon',
    icon: AnchorBottomIcon,
  },
] as const

const KINDS = [
  { id: 'bubble', label: 'Dialogue' },
  { id: 'caption', label: 'Caption' },
  { id: 'sfx', label: 'Sound effect' },
  { id: 'garbage', label: 'Not lettering' },
] as const

/**
 * The four numbers, so the fields below are one shape said four times — each
 * with how finely it is kept and how far a pixel of scrub moves it.
 *
 * Two of them have an Auto to go back to: a size or a line height that has been
 * set stays set, and without a way back the only route to letting the balloon
 * decide again was Reset — which throws away the bold and the alignment with
 * it. The way back is a right-click on the field, the same gesture that puts
 * spacing and stroke back to nought — see `reset`.
 */
const DIALS = [
  { key: 'size', label: 'Size', suffix: 'px', precision: 0, step: 0.5 },
  { key: 'line', label: 'Line', suffix: '', precision: 2, step: 0.01 },
  { key: 'spacing', label: 'Spacing', suffix: 'px', precision: 1, step: 0.1 },
  { key: 'stroke', label: 'Stroke', suffix: 'px', precision: 1, step: 0.1 },
] as const

/** The number a dial shows — on Auto, the size or line the balloon is actually set at. */
function dial (key: (typeof DIALS)[number]['key']): number {
  if (key === 'size') return sizeAt.value
  if (key === 'line') return lineAt.value

  return style.value[key]
}

function setDial (key: (typeof DIALS)[number]['key'], to: number) {
  setLettering({ [key]: to })
}

/** Whether a dial is on Auto — a number the balloon chose rather than somebody. */
function onAuto (key: (typeof DIALS)[number]['key']) {
  return (key === 'size' || key === 'line') && !mixed(key) && style.value[key] === null
}

/**
 * Whether a setting has anything to go back from — the kind's default, which is
 * Auto for the size, the line and both colours and nought for the rest. A row
 * already there does not offer to put it there, and a mixed one always can.
 */
function canReset (key: (typeof DIALS)[number]['key'] | (typeof INKS)[number]['key']) {
  return mixed(key) || style.value[key] !== LETTERING[key]
}

/** Hand a setting back to the default. */
function reset (key: (typeof DIALS)[number]['key'] | (typeof INKS)[number]['key']) {
  setLettering({ [key]: LETTERING[key] })
}

const { inkOf } = usePaper()

/**
 * The two colours, as one list for the same reason the dials are one: they are
 * the same row said twice, and a reader running down the column should not have
 * to notice which of them they are looking at.
 */
const INKS = [
  { key: 'color', label: 'Fill', of: (ink: Inking) => ink.fill },
  { key: 'outline', label: 'Outline', of: (ink: Inking) => ink.outline },
] as const

/**
 * What the swatches are showing when nobody has chosen — the colours the page is
 * *actually* being set in, read off the first selected block.
 *
 * The resolved pair rather than a neutral placeholder, which is the whole value
 * of the row. "Auto" on its own does not say whether this balloon is about to be
 * lettered black or white, and on a page that mixes night panels with day ones
 * that is precisely the thing worth being able to see without pressing anything.
 *
 * The first block's, like the face menu above: a selection of one kind is the
 * case worth naming, and a mixed one says Mixed instead.
 */
const autoInk = computed(() => {
  const first = selected.value[0]

  return first ? inkOf(first, style.value) : inking(style.value, null)
})

/** Where a swatch sits, chosen or worked out. */
function ink (item: (typeof INKS)[number]) {
  return style.value[item.key] ?? item.of(autoInk.value)
}

function setInk (key: (typeof INKS)[number]['key'], to: string | null) {
  setLettering({ [key]: to })
}
/* ---------- the shape the lines wrap into ---------- */

const SHAPE_LABELS: Record<LetterShape, { label: string, note: string }> = {
  box: { label: 'Box', note: 'the frame as it is' },
  soft: { label: 'Soft', note: 'corners rounded off' },
  oval: { label: 'Oval', note: 'the ellipse in the frame' },
  diamond: { label: 'Diamond', note: 'short, long, short' },
  custom: { label: 'Custom', note: 'drawn below' },
}

const SHAPE_ORDER: LetterShape[] = ['box', 'soft', 'oval', 'diamond', 'custom']

/** A name for Auto, like the face menu's — see `AUTO_FACE`. */
const AUTO_SHAPE = 'auto'

/**
 * What Auto means for the first selected block — as it would be once it has a
 * translation, since an untranslated block is always set in its box.
 */
const autoShape = computed(() => {
  const first = selected.value[0]

  return first ? shapeFor({ shape: null, points: null }, { type: first.type, translation: 'x', room: first.room, letter: first.letter }) : 'box'
})

function setShape (next: string) {
  if (next === AUTO_SHAPE) return setLettering({ shape: null })

  const shape = next as LetterShape

  // A custom shape starts from whatever was showing, so choosing it is a place
  // to start dragging from rather than a jump to something else.
  if (shape === 'custom' && !style.value.points) {
    const from = style.value.shape ?? autoShape.value

    return setLettering({ shape, points: customFrom(from === 'custom' ? 'soft' : from) })
  }

  setLettering({ shape })
}

/** The first selected block's frame, width over height, for the shape editor to draw it true. */
const frameAspect = computed(() => {
  const first = selected.value[0]
  const box = first && balloon(first)

  return box && box.h ? box.w / box.h : 1
})

/* ---------- the chapter's standard size, and how the selection fitted ---------- */

/** The smallest the standard may be squeezed to — see `SQUEEZE_FLOOR`. */
const floor = computed(() => (standard.value === null ? null : Math.round(standard.value * SQUEEZE_FLOOR)))

/** How each selected, translated line came out — see `LetterFit`. */
const fitted = computed(() => selected.value
  .filter((block) => block.translation.trim())
  .map((block) => ({ block, fit: fitOf(block) })))

/** The lines that do not fit even squeezed — flagged rather than set tiny. */
const over = computed(() => fitted.value.filter(({ fit }) => fit?.over).map(({ block }) => block))

/** How many were squeezed to keep the standard: hyphenated, tightened, or set smaller. */
const squeezedCount = computed(() => fitted.value.filter(({ block, fit }) => fit && !fit.over
  && (fit.hyphens || fit.tight || (standard.value !== null && standardApplies(block.type) && styleOf(block).size === null && fit.size < standard.value))).length)

/**
 * How many characters a line may have to fit its frame at the size it is aimed
 * at — what "Shorten to fit" asks the model for.
 *
 * Measured, not reckoned from the frame: the line is fitted as it stands with
 * no floor, and the size it would take says how much too long it is. Type set
 * at size s takes room in proportion to s², so a line that only fits at 40 when
 * it is meant to be at 55 has (40 / 55)² of the room it needs — about half.
 * A little under that, because a wording written to a count seldom lands on it.
 */
function budgetOf (block: Block): number | null {
  const input = inputOf(block)
  const aim = styleOf(block).size ?? standard.value ?? fitOf(block)?.size

  if (!input || !aim) return null

  const holds = fitSize(input, { min: 4, max: aim }).size
  const chars = [...block.translation.trim()].length

  return Math.max(4, Math.floor(chars * (holds / aim) ** 2 * 0.95))
}

/** Which line is being shortened, so the button can say so and not be pressed twice. */
const shortening = ref(false)

/** Why "Shorten to fit" cannot be pressed, or null where it can. */
const cannotShorten = computed(() => {
  if (translateSettings.value.engine === 'google') return 'Shortening asks an AI model — choose AI · Text or AI · Image in Translate.'
  if (translating.value || shortening.value) return 'A translation is already running.'

  return null
})

/**
 * Ask the model for a shorter wording of every line that will not fit, one at a
 * time — the professional answer to a line that will not go, where shrinking
 * the type further is the amateur one. Each new wording is kept as a version
 * of its line, so the longer one is a click away in the Text panel.
 */
async function shorten () {
  if (cannotShorten.value) return

  shortening.value = true

  try {
    // A snapshot: each answer refits its line, and the list moves under a loop over it.
    for (const block of [...over.value]) {
      const budget = budgetOf(block)

      if (budget) await shortenBlock(block, budget)
    }
  } finally {
    shortening.value = false
  }
}
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-3">
    <p v-if="!selected.length" class="text-muted-foreground py-1 text-xs">
      Select lettering on the page to set it.
    </p>

    <template v-else>
      <!--
        The dock supplies this panel's name and its twirl, so the header keeps
        only what the dock cannot know about: how many blocks are being set, and
        the way back to the defaults.
      -->
      <div class="flex items-center justify-between">
        <UFieldLabel>
          {{ selected.length === 1 ? 'One block' : `${selected.length} blocks` }}
        </UFieldLabel>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground text-[10px] tracking-wider uppercase"
          @click="resetLettering()"
        >
          Reset
        </button>
      </div>

      <!-- What the line is. -->
      <USelect :model-value="kind ?? ''" @update:model-value="setKind(String($event))">
        <USelectTrigger size="sm" class="w-full">
          <USelectValue :placeholder="kind ? undefined : 'Mixed'" />
        </USelectTrigger>
        <USelectContent>
          <USelectItem v-for="item in KINDS" :key="item.id" :value="item.id">
            {{ item.label }}
          </USelectItem>
        </USelectContent>
      </USelect>

      <!--
        The face. Every row is drawn in the face it names, because that is the
        only description of a typeface anybody actually reads — and the real
        name goes underneath, since "Retro FX" says what it is for and nothing
        about what it is.

        Below the type row and above everything else: which face a block is set
        in follows from what the block is, and everything under this is a
        setting applied to the face rather than a choice of one.
      -->
      <USelect
        :model-value="mixed('font') ? '' : (style.font ?? AUTO_FACE)"
        @update:model-value="setFont(String($event))"
      >
        <!--
          The trigger says what it is showing itself, through `USelectValue`'s
          slot rather than instead of it.

          Both halves of that are load-bearing. Left to itself the value takes a
          copy of the chosen row's text when it is chosen and never looks again,
          which is wrong here: retype a block from dialogue to sound effect and
          Auto starts meaning a different face, so a trigger that had cached
          "Auto — Bangers" would go on saying it over lettering already set in
          Anime Ace. But replacing it outright breaks the menu — a `SelectValue`
          is the only thing that registers `valueElement`, and the item-aligned
          placement this dock's selects use gives up silently without one, so
          the popup mounts and is never put anywhere. It opened, in the DOM,
          off the screen.
        -->
        <USelectTrigger size="sm" class="w-full" :title="following">
          <USelectValue class="min-w-0 flex-1 text-left">
            <span v-if="mixed('font')" class="text-muted-foreground">Mixed</span>
            <template v-else>
              <span class="truncate" :style="chosen ? { fontFamily: chosen.stack } : undefined">
                {{ chosen?.label ?? 'Auto' }}
              </span>
              <span class="text-muted-foreground shrink-0 text-[10px]">{{ (chosen ?? autoFace)?.note }}</span>
            </template>
          </USelectValue>
        </USelectTrigger>
        <USelectContent>
          <USelectItem :value="AUTO_FACE">
            Auto
            <span class="text-muted-foreground text-[10px]">{{ autoFace?.note }}</span>
          </USelectItem>
          <USelectItem v-for="item in FONTS" :key="item.key" :value="item.key">
            <span :style="{ fontFamily: item.stack }">{{ item.label }}</span>
            <span class="text-muted-foreground text-[10px]">{{ item.note }}</span>
          </USelectItem>
        </USelectContent>
      </USelect>

      <!--
        How the face is cut, and which way the line runs — one row, two groups.
        Separate groups because they answer different questions: the marks are
        several at once and any of them may be off, the direction is one of two
        and may be neither. Sharing a group would say they were the same kind of
        choice, and a seam between them is the cheapest way to say they are not.
      -->
      <div class="flex gap-2">
        <UToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          class="flex-1"
          :model-value="MARKS.filter((mark) => !mixed(mark.key) && style[mark.key]).map((mark) => mark.key)"
          @update:model-value="setLettering(Object.fromEntries(
            MARKS.map((mark) => [mark.key, (($event ?? []) as string[]).includes(mark.key)]),
          ))"
        >
          <UToggleGroupItem
            v-for="mark in MARKS"
            :key="mark.key"
            :value="mark.key"
            :aria-label="mark.label"
            class="flex-1"
          >
            <component :is="mark.icon" class="size-4" />
          </UToggleGroupItem>
        </UToggleGroup>

        <!--
          Letters rather than glyphs: no icon says "down the page instead of
          across it" as plainly as the two initials every editor already uses.

          Three states, not two. Neither pressed means the block decides for
          itself — vertical while it is still the Japanese that was read off the
          page, across once it has been translated into something written that
          way. Pressing the one already down hands the decision back.
        -->
        <UToggleGroup
          type="single"
          variant="outline"
          size="sm"
          :model-value="mixed('vertical') ? '' : (style.vertical === null ? '' : (style.vertical ? 'v' : 'h'))"
          @update:model-value="setLettering({ vertical: $event ? $event === 'v' : null })"
        >
          <UToggleGroupItem
            value="h"
            :aria-label="`Set across the page${style.vertical === false ? ' — press again to follow the block' : ''}`"
            :title="reading"
            class="w-9 font-semibold"
          >
            H
          </UToggleGroupItem>
          <UToggleGroupItem
            value="v"
            :aria-label="`Set down the page${style.vertical === true ? ' — press again to follow the block' : ''}`"
            :title="reading"
            class="w-9 font-semibold"
          >
            V
          </UToggleGroupItem>
        </UToggleGroup>
      </div>

      <div class="grid gap-1.5">
        <UFieldLabel>Alignment</UFieldLabel>
        <div class="flex gap-2">
          <UToggleGroup
            type="single"
            variant="outline"
            size="sm"
            class="flex-1"
            :model-value="mixed('align') ? '' : style.align"
            @update:model-value="$event && setLettering({ align: $event as TextAlign })"
          >
            <UToggleGroupItem
              v-for="item in ALIGNS"
              :key="item.key"
              :value="item.key"
              :aria-label="item.label"
              :disabled="'off' in item && item.off"
              :title="'off' in item && item.off ? 'Nothing to justify against down the page' : item.label"
              class="flex-1"
            >
              <component :is="item.icon" class="size-4" />
            </UToggleGroupItem>
          </UToggleGroup>

          <UToggleGroup
            type="single"
            variant="outline"
            size="sm"
            :model-value="mixed('anchor') ? '' : style.anchor"
            @update:model-value="$event && setLettering({ anchor: $event as TextAnchor })"
          >
            <UToggleGroupItem
              v-for="item in ANCHORS"
              :key="item.key"
              :value="item.key"
              :aria-label="item.label"
            >
              <component :is="item.icon" class="size-4" />
            </UToggleGroupItem>
          </UToggleGroup>
        </div>
      </div>

      <!--
        The shape the lines wrap into. A professional letterer breaks a round
        balloon's lines short, long, long, short; the room measured inside it is
        a rectangle, and its corners are the first place a full-width line looks
        wrong. Auto is Soft for a balloon and the plain box for everything else —
        see `shapeFor`. Only a translation is shaped: until then the block shows
        what was read, where it was read.
      -->
      <div class="grid gap-1.5">
        <UFieldLabel>Shape</UFieldLabel>
        <USelect
          :model-value="mixed('shape') ? '' : (style.shape ?? AUTO_SHAPE)"
          @update:model-value="setShape(String($event))"
        >
          <USelectTrigger size="sm" class="w-full">
            <USelectValue class="min-w-0 flex-1 text-left">
              <span v-if="mixed('shape')" class="text-muted-foreground">Mixed</span>
              <template v-else>
                <span>{{ style.shape ? SHAPE_LABELS[style.shape].label : 'Auto' }}</span>
                <span class="text-muted-foreground text-[10px]">
                  {{ style.shape ? SHAPE_LABELS[style.shape].note : SHAPE_LABELS[autoShape].label }}
                </span>
              </template>
            </USelectValue>
          </USelectTrigger>
          <USelectContent>
            <USelectItem :value="AUTO_SHAPE">
              Auto
              <span class="text-muted-foreground text-[10px]">{{ SHAPE_LABELS[autoShape].label }}</span>
            </USelectItem>
            <USelectItem v-for="key in SHAPE_ORDER" :key="key" :value="key">
              {{ SHAPE_LABELS[key].label }}
              <span class="text-muted-foreground text-[10px]">{{ SHAPE_LABELS[key].note }}</span>
            </USelectItem>
          </USelectContent>
        </USelect>

        <PanelShapeEditor
          v-if="!mixed('shape') && style.shape === 'custom' && style.points"
          :points="style.points"
          :aspect="frameAspect"
          @update:points="setLettering({ points: $event })"
        />
      </div>

      <USeparator />

      <!--
        The four numbers and the two colours, two to a row: size beside line,
        spacing beside stroke, fill beside outline — each pair the same decision
        made twice, and the column half as long to run down. Scrubbed fields
        rather than sliders: see `PanelNumberField` for why a track could not be
        aimed.

        A right-click on any of them puts it back — Auto for the four that have
        one, nought for the other two — and only where it is not there already.
        On Auto a number is the size the balloon is actually set at, dimmed and
        marked; a colour is the ink actually being used, read off the page.
      -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2">
        <PanelNumberField
          v-for="item in DIALS"
          :key="item.key"
          label-class="w-11 text-[11px]"
          :label="item.label"
          :value="mixed(item.key) ? null : dial(item.key)"
          :from="dial(item.key)"
          :suffix="item.suffix"
          :precision="item.precision"
          :step="item.step"
          :nudge="range[item.key].step"
          :min="range[item.key].min"
          :max="range[item.key].max"
          :automatic="onAuto(item.key)"
          :hint="onAuto(item.key) ? 'auto' : undefined"
          :resettable="canReset(item.key)"
          @set="setDial(item.key, $event)"
          @reset="reset(item.key)"
        />

        <div
          v-for="item in INKS"
          :key="item.key"
          class="flex min-w-0 items-center gap-1.5"
          @contextmenu="canReset(item.key) && ($event.preventDefault(), reset(item.key))"
        >
          <span
            class="w-11 flex-none text-[11px]"
            :class="canReset(item.key) ? 'text-foreground' : 'text-muted-foreground'"
          >{{ item.label }}</span>
          <!--
            The swatch is the input. A colour well that opens a picker is what a
            native colour input already is — see `tool/Options`, which makes the
            same call for the paint brush. What it says is written in whichever
            ink stands out against it, so it reads on white and on black alike.
          -->
          <label
            class="border-border relative flex h-7 min-w-0 flex-1 items-center justify-end overflow-hidden rounded-sm border px-1.5"
            :class="mixed(item.key) && 'bg-muted'"
            :style="mixed(item.key) ? undefined : { background: ink(item), color: reverseOf(ink(item)) }"
            :title="canReset(item.key)
              ? `Pick the ${item.label.toLowerCase()} colour. Right-click to go back to Auto.`
              : `Pick the ${item.label.toLowerCase()} colour — Auto reads it off the page`"
          >
            <span class="pointer-events-none font-mono text-[10px] uppercase">
              {{ mixed(item.key) ? 'Mixed' : style[item.key] === null ? 'auto' : showColour(style[item.key]) }}
            </span>
            <input
              :value="ink(item)"
              type="color"
              class="absolute inset-0 size-full cursor-pointer opacity-0"
              :aria-label="`${item.label} colour`"
              @input="setInk(item.key, ($event.target as HTMLInputElement).value)"
            >
          </label>
        </div>
      </div>

      <!--
        The chapter's standard size: every ordinary line of dialogue set alike,
        squeezed a little where a balloon is tight, and flagged where even that
        will not do — see `useLetteringStandard` and `fitStandard`. Off, each
        balloon is set as large as it holds, which is a rough draft's look.
      -->
      <div class="border-border/60 grid gap-1.5 border-t pt-3">
        <div class="flex items-center gap-2">
          <PanelNumberField
            class="min-w-0 flex-1"
            label-class="w-24 text-[11px]"
            label="Standard size"
            :value="standard ?? sizeAt"
            :from="standard ?? sizeAt"
            suffix="px"
            :precision="0"
            :step="0.5"
            :nudge="1"
            :min="range.size.min"
            :max="range.size.max"
            :automatic="standard === null"
            :hint="standard === null ? 'off' : undefined"
            :resettable="standard !== null"
            @set="setStandard($event)"
            @reset="setStandard(null)"
          />
          <UButton
            variant="outline"
            size="sm"
            :disabled="!scan"
            title="Make this block's size the chapter's standard"
            @click="setStandard(sizeAt)"
          >
            Use this
          </UButton>
        </div>
        <p class="text-muted-foreground text-[11px] leading-snug">
          <template v-if="standard === null">
            Off — each balloon is set as large as it holds. Right-click the field to turn it off again once set.
          </template>
          <template v-else>
            Dialogue is set at {{ standard }}px for the whole chapter; a tight balloon is hyphenated, tightened,
            then squeezed down to {{ floor }}px. Sound effects keep their own size.
          </template>
        </p>

        <!--
          How the selection came out against it — said, because a squeeze nobody
          can see is the lettering quietly changing size, and a line that does
          not fit is the one thing on the page a letterer has to act on.
        -->
        <div v-if="over.length" class="bg-destructive/10 text-destructive grid gap-1.5 rounded-md p-2 text-[11px]">
          <p class="flex items-start gap-1.5 leading-snug">
            <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
            <span>
              {{ over.length === 1 ? 'This line does' : `${over.length} lines do` }} not fit{{ floor ? ` even at ${floor}px` : '' }}.
              A shorter wording is the professional fix; the longer one is kept as a version.
            </span>
          </p>
          <UButton
            variant="outline"
            size="sm"
            :disabled="!!cannotShorten"
            :title="cannotShorten ?? 'Ask the model for a wording that fits'"
            @click="shorten()"
          >
            <WandSparklesIcon class="size-4" />
            {{ shortening ? 'Shortening…' : 'Shorten to fit' }}
          </UButton>
        </div>
        <p v-else-if="squeezedCount" class="text-muted-foreground text-[11px] leading-snug">
          {{ squeezedCount === 1 ? 'Squeezed to fit' : `${squeezedCount} squeezed to fit` }} — hyphenated, set tighter or a little smaller.
        </p>
      </div>

      <!--
        Not a slider's worth of guessing but a measurement: each line is laid out
        in its own balloon and the largest size that still fits is written down.
        Off until the scan has been measured, because there is nothing to fit to
        until then — see `fit`.
      -->
      <div class="grid grid-cols-2 gap-2">
        <UButton
          variant="outline"
          size="sm"
          :disabled="!scan"
          class="text-primary border-primary/30 bg-primary/10"
          title="Set the words at the largest size the frame holds"
          @click="fit()"
        >
          <ScanIcon class="size-4" /> Fit text to bubble
        </UButton>
        <!--
          The inverse, beside it: the frame brought to the words, which stay
          where they are — see `fitFrame`.
        -->
        <UButton
          variant="outline"
          size="sm"
          :disabled="!canFitFrame"
          class="text-primary border-primary/30 bg-primary/10"
          title="Shrink the frame to the words, leaving them where they are"
          @click="fitFrame()"
        >
          <ShrinkIcon class="size-4" /> Fit bubble to text
        </UButton>
      </div>

      <!--
        Which box the page's handles are on — the standing question this panel
        is the right home for, since the frame is a typesetting decision and
        everything above it is too.

        It is deliberately *not* the only way to reach it. A panel can be shut,
        and the moment somebody needs the reading box is the moment they are
        looking at a balloon and can see the repair under it is cut wrong — so
        the canvas carries the same switch on `F` and says which one is live by
        drawing the other faint. See `Framing`, which argues the choice, and
        `frameGhosts`, which draws it.
      -->
      <div class="border-border/60 grid gap-2 border-t pt-3">
        <div class="flex items-center justify-between gap-2">
          <UFieldLabel class="text-muted-foreground">Handles move</UFieldLabel>
          <kbd class="text-muted-foreground/70 text-[10px] tracking-wider uppercase">F</kbd>
        </div>

        <UToggleGroup
          type="single"
          variant="outline"
          size="sm"
          class="w-full"
          :model-value="framing"
          @update:model-value="$event && (framing = $event as Framing)"
        >
          <UToggleGroupItem
            value="lettering"
            class="flex-1"
            title="Drag the box the translation is set in. The reading underneath, and the repair cut from it, are left alone."
          >
            Lettering
          </UToggleGroupItem>
          <UToggleGroupItem
            value="reading"
            class="flex-1"
            title="Drag the box the lettering was found in — what the cleaning under it was cut from. Correcting one re-cleans the block."
          >
            Reading
          </UToggleGroupItem>
        </UToggleGroup>

        <p class="text-muted-foreground text-[11px] leading-snug">
          <template v-if="framing === 'reading'">
            Moving a reading re-cuts what is cleaned under it.
          </template>
          <template v-else-if="framed">
            Moved off {{ framed === 1 ? 'its block' : 'their blocks' }}. The artwork under
            {{ framed === 1 ? 'it' : 'them' }} is unaffected.
          </template>
          <template v-else>
            Untranslated blocks always move their own box.
          </template>
        </p>

        <!--
          Only when there is something to put back, so the row does not offer to
          undo work nobody has done.
        -->
        <UButton v-if="framed" variant="ghost" size="sm" class="text-muted-foreground" @click="resetFrame()">
          <Undo2Icon class="size-4" />
          Put lettering back on {{ framed === 1 ? 'the block' : 'the blocks' }}
        </UButton>
      </div>
    </template>
  </UFieldGroup>
</template>
