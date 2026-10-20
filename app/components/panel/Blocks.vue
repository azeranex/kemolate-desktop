<script setup lang="ts">
/**
 * The blocks on the page, in reading order. Its heading, its icon and which
 * dock it sits in are not its own business — see the registry in
 * `usePanelDock`.
 *
 * The list and the page are the same selection, held in `useComic` rather than
 * here: picking a row lights the box on the page and picking the box lights the
 * row, without either having to know the other exists.
 */
import {
  ArrowUpDownIcon,
  MessageCircleXIcon,
  RotateCwSquareIcon,
  SquareSplitHorizontalIcon,
  SquaresUniteIcon,
} from '@lucide/vue'

import type { Component, MaybeRef } from 'vue'

import PanelBlockListRow from '~/components/panel/BlockListRow.vue'

// Imported rather than auto-imported: a new component is unknown to the running
// dev server until it restarts.

const {
  page, selection, selected, select, blockPickable, setDown, update, updateMany, removeBlock,
  setBlocks, moveBlock, framedBox, writesLetter,
} = useComic()
const { canMerge, canSplit, merge, split } = useBlockMerge()
const { direction } = useReadingDirection()

// Reading one row again is `useOcr`'s — it owns which engine reads and the key
// that engine may need. This panel only says which block. The same split the
// Text panel makes, for the same button.
const { readBlock, running: reading, error: readError } = useOcr()

const blocks = computed(() => page.value?.blocks ?? [])

const failure = ref<string | null>(null)

async function run (action: () => Promise<string | null>) {
  failure.value = await action()
}

// A balloon is one row and one selection, because it *is* one block — nothing
// here has to know it has parts. That is the whole point of the compound being
// an object rather than a grouping laid over the list.

/**
 * Put the page in the order somebody reads it — see `readingOrder`.
 *
 * The chapter's own direction, which is now a thing the client can ask for:
 * `useReadingDirection`, set in the workspace settings and shared with everyone
 * working on it. This used to be right-to-left on a plain press and
 * left-to-right on a Shift-click, because the workspace's `direction` column
 * existed and nothing had ever read it — a hidden modifier standing in for a
 * setting, discoverable by nobody and lasting exactly as long as the press.
 *
 * Shift is kept, and now means *the other way from this chapter's* rather than
 * "left to right". A page laid out against the grain of the book it is in is
 * the case it was always for, and one press is still the right price for it.
 */
function sortIntoReadingOrder (event?: MouseEvent) {
  if (!page.value || blocks.value.length < 2) return

  const way = event?.shiftKey
    ? (direction.value === 'rtl' ? 'ltr' : 'rtl')
    : direction.value

  setBlocks(page.value.id, readingOrder(blocks.value, way))
}

/**
 * What the Sort button says it will do — computed, because it changed once and
 * lied for a week. The label used to be the literal "right to left. Shift for
 * left to right", written when a plain press *was* right to left; when the
 * press became "this chapter's direction" the string stayed behind, so on a
 * left-to-right chapter both halves of the tooltip were wrong. A label that
 * restates behaviour has to be derived from the same value the behaviour reads.
 */
const sortLabel = computed(() => {
  const [plain, other] = direction.value === 'rtl'
    ? ['right to left', 'left to right']
    : ['left to right', 'right to left']

  return `Sort into reading order — ${plain}, as this chapter reads. Shift for ${other}`
})

/**
 * Read one row's balloon again, from here rather than from the Text panel —
 * the row does not have to be selected first, which is the point of the button
 * being on the row. A failure lands in `failure` beside the rows like a
 * refused merge, and for the reason that slot gives: the complaint is about a
 * row right here, and a message in another panel — where `useOcr`'s own error
 * is drawn — may be shut or docked out of sight.
 */
async function reread (block: Block) {
  const here = page.value

  if (!here) return

  failure.value = null

  const got = await readBlock(here.id, block.id)

  if (got === null) failure.value = readError.value
}

/**
 * Turn the lettering of everything selected a quarter, about each block's own
 * centre, leaving every box exactly where it sits on the page.
 *
 * For the baseline, not for the box — which is the reverse of what this said on
 * its first pass, and worth saying why. It used to swap `w` and `h` in the
 * block's own frame and leave the angle alone, on the reading that the *box* was
 * the mis-measurement. The case that settled it is a label printed sideways on
 * the artwork — "Duo Soda" running up the side of a bottle. There the detector's
 * tall narrow rectangle is sitting exactly over the label and is right; the type
 * is set across it and wraps every two letters. The local-frame swap made that
 * box wide, moved it off the artwork and left the wrapping alone: both halves
 * backwards. So `transposed` is now a quarter turn of the box's frame — same
 * four corners on the page, other axis for the words — and it argues the whole
 * of that at its own definition, including why it has to happen in the scan's
 * own pixels rather than in the percentages a block is held in.
 *
 * **Which way, and how to get back.** Clockwise, and Shift for anticlockwise —
 * the same modifier the transform grips already read off a press, so it is a
 * habit rather than a new rule. Two presses are the same outline with the type
 * upside down and four come back to the numbers they started at, so the button
 * is a cycle rather than a toggle. The tooltip says all of that out loud,
 * because a control that quietly turned type upside down with no visible way
 * back would be a trap. Cmd+Z is the other way back, and takes the whole
 * selection in one press.
 *
 * **`vertical` is pinned rather than cleared**, which is the other thing the
 * first pass had to give up. It used to write null — "as it reads" — and let
 * `verticalOf` decide again. That worked when the swap left the angle alone, and
 * cannot now: the guess reads the block's own `w` and `h`, the turn swaps them,
 * and `readsVertical`'s `h > w * 0.8` veto therefore flips with it. A tall CJK
 * balloon guessed vertical comes back guessed horizontal — which, in a frame
 * that has itself turned ninety degrees, is the same words running the same way
 * down the same page. The guess would exactly cancel the turn and the button
 * would appear to do nothing.
 *
 * So the direction the block is set in *now* is written down, and the turn of
 * the frame is left as the only thing that changed. That is not the H button
 * wearing a second hat: the value written is the one already in force, read back
 * through `setDown`, so nothing is being chosen on the reader's behalf. What is
 * being refused is the guess changing its mind underneath a turn.
 *
 * Two kinds of block are left alone and counted rather than quietly mangled:
 *
 * - a block whose corners have been pulled. `transposed` refuses it and argues
 *   why; the test here is only so the panel can say how many.
 * - a balloon made of columns. Its `children` carry boxes that were measured
 *   separately, so turning the parent's frame and leaving theirs alone sets the
 *   balloon one way and its own pieces the other — and there is no turn of the
 *   pieces that would be a fact rather than a guess about a layout somebody
 *   assembled.
 *
 * `w`, `h` and `angle` are all in the shape `useBlockSync` watches, so each
 * block goes back to its row on its own after the settle. `style` has no column
 * on `blocks` at all — it belongs to `translations` — and is watched by
 * `useTranslationSync` instead, which is what makes the pin outlive a reload.
 * It did not, once: these blocks came back with their turned frames, handed the
 * direction back to the guess, and on a near-square CJK balloon the veto above
 * decided the other way and the type flipped.
 */
function transpose (event?: MouseEvent) {
  const here = page.value
  const scan = here?.scan

  failure.value = null

  // The two spaces meet at the scan's size, and there is no honest answer to
  // "turn this box a quarter" before anything has measured it.
  if (!here || !scan?.width || !scan.height) return

  const patches: { id: string, patch: Partial<Block> }[] = []
  let refused = 0

  for (const block of selected.value) {
    // The framed box, and this button is why it has to be: turning a balloon a
    // quarter is a typesetting act — it pins `style.vertical` in the same
    // breath — so on a translated block it must turn the *lettering frame* and
    // leave the reading where the detector put it. Transposing the block's own
    // box would move the rectangle the repair was cut from, which is the exact
    // failure `Block.letter` exists to end.
    const box = toOriented(framedBox(block), scan)

    if (block.children?.length || isDistorted(box)) {
      refused++
      continue
    }

    // Ahead of the spread rather than inside it. `toBoxed` leaves an angle of
    // nought off entirely — see its note — and a patch is *merged* onto the
    // block, so the fourth press, the one that lands back on nought, would
    // otherwise keep the third press's angle and read as a button that had
    // stopped working.
    const turned = { angle: 0, ...toBoxed(transposed(box, event?.shiftKey), scan) }

    patches.push({
      id: block.id,
      patch: {
        // A frame is replaced whole; the block's box is patched. The same
        // division `writeBox` makes on the canvas, and for the same reason.
        ...(writesLetter(block)
          ? { letter: { ...letterBoxOf(block), ...turned } }
          : turned),
        // Over the block's own settings rather than over the resolved style, so
        // a block that has never been lettered still carries only this one
        // field — the same rule `setLettering` follows and for the same reason.
        style: { ...block.style, vertical: setDown(block) },
      },
    })
  }

  // One step for the whole selection — see `updateMany`.
  updateMany(patches)

  if (refused) {
    failure.value = `${refused} block${refused === 1 ? ' was' : 's were'} left alone: a balloon made of columns, or a box whose corners have been pulled by hand, has no transpose.`
  }
}

/**
 * Say the selected blocks are not lettering.
 *
 * Marking rather than deleting: a block called garbage keeps its box and its
 * reading, stays in the list wearing a red label, and can be argued with. The
 * sweep in the corner is the one that actually throws anything away.
 */
function markGarbage () {
  // One step for the selection — see `BlocksEntry`.
  updateMany(selected.value.map((block) => ({ id: block.id, patch: { type: 'garbage' as const } })))
}

/**
 * Throw away everything marked garbage.
 *
 * The only destructive thing on this bar, so it says how much and asks first —
 * the blocks are gone from the page, and undo is the browser's rather than the
 * server's.
 */
function discardGarbage () {
  const here = page.value
  const doomed = blocks.value.filter((block) => block.type === 'garbage')

  if (!here || !doomed.length) return
  if (!confirm(`Discard ${doomed.length} block${doomed.length === 1 ? '' : 's'} marked garbage?`)) return

  setBlocks(here.id, blocks.value.filter((block) => block.type !== 'garbage'))
}

/**
 * Dragging a row to somewhere else in the reading order.
 *
 * The whole row is the handle. A grip would be one more thing in a row that is
 * already six things wide, and a native drag does not begin until the pointer
 * has travelled — so a press that does not move is still a press, and picking a
 * block by clicking it goes on working.
 *
 * `dropAt` is a gap rather than a row: nought is above the first row, and one
 * past the last is below it, which is the only way to say "put it at the end".
 */
const dragId = ref<string | null>(null)
const dropAt = ref<number | null>(null)

function onDragStart (id: string, event: DragEvent) {
  dragId.value = id

  if (!event.dataTransfer) return

  // Firefox starts no drag at all from an empty transfer.
  event.dataTransfer.setData('text/plain', id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver (index: number, event: DragEvent) {
  if (!dragId.value) return

  // Without this the browser reads the row as refusing the drop.
  event.preventDefault()

  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()

  // Past the middle of a row is a drop below it, which is the same gap as
  // above the next one.
  dropAt.value = event.clientY < box.top + box.height / 2 ? index : index + 1
}

function onDrop () {
  if (dragId.value && dropAt.value !== null) moveBlock(dragId.value, dropAt.value)

  endDrag()
}

function endDrag () {
  dragId.value = null
  dropAt.value = null
}

/** Which edge of the row at `index` the insertion line belongs on. */
function edgeAt (index: number) {
  if (dropAt.value === null) return null
  if (dropAt.value === index) return 'top'
  // Only the last row can be dropped past, and it draws that itself.
  if (dropAt.value > index && index === blocks.value.length - 1) return 'bottom'

  return null
}

/* ---------- the rows ---------- */

/**
 * The selection as a set, so each row's flag is one lookup — and asked here,
 * once per render of the panel, rather than by each row, which would render
 * every row again on every change of it. See `PanelBlockListRow`.
 */
const chosen = computed(() => new Set(selection.value))

/** A row's block, by the id it says it is. */
const blockOf = (id: string) => blocks.value.find((block) => block.id === id)

/*
 * What a row asks for, answered. Named functions rather than inline ones on
 * purpose: a handler written inline in the list names its row's block, so the
 * template compiler cannot keep it and every row would be handed a new one on
 * every render — a changed prop, and every row drawn again.
 */
function onPick (id: string, event: MouseEvent) {
  select(id, { add: addsToSelection(event), range: event.shiftKey })
}

function onHide (id: string) {
  const block = blockOf(id)

  if (block) update(id, { hidden: !block.hidden })
}

function onReread (id: string) {
  const block = blockOf(id)

  if (block) reread(block)
}

function onRemove (id: string) {
  removeBlock(id)
}

/**
 * The type menu — one for the panel, opened against whichever row asked.
 *
 * It was one per row, and a Reka menu is a dozen components before it has
 * drawn anything: a root, a popper, an anchor, a trigger, a portal and their
 * primitives, all kept mounted for a menu that is shut, and all rendered again
 * with their row. Now the rows carry a plain button and the menu is anchored to
 * whichever one was pressed (`reference`), which is all a menu that only ever
 * opens one at a time needs.
 *
 * The anchor outlives the menu's closing on purpose: the content animates out,
 * and without its anchor for those frames it would jump to the corner first.
 */
const typeMenu = ref(false)
const typeFor = shallowRef<{ id: string, anchor: HTMLElement } | null>(null)

function openType (id: string, anchor: HTMLElement) {
  typeFor.value = { id, anchor }
  typeMenu.value = true
}

function setType (type: BlockType) {
  if (typeFor.value) update(typeFor.value.id, { type })
}

/**
 * Where focus goes when the menu shuts: back to the button that opened it, as a
 * trigger's would — unless the menu was shut by a press somewhere else, where
 * the press has already said where it wants focus to be. Reka does the same
 * for a menu with a trigger; this one has none, so it is said here.
 */
let pressedOutside = false

function onTypeOutside () {
  pressedOutside = true
}

function onTypeClosed (event: Event) {
  event.preventDefault()

  if (!pressedOutside) typeFor.value?.anchor.focus()

  pressedOutside = false
}

/** What the button in the corner offers to sweep up, and how much of it. */
const garbage = computed(() => blocks.value.filter((block) => block.type === 'garbage').length)

/**
 * The row of actions above the list.
 *
 * A list rather than five spelled-out buttons, because each now carries a
 * tooltip as well as an icon and they are otherwise identical — written out,
 * the same eight lines would appear five times and the only thing telling them
 * apart would be buried in the middle of it.
 *
 * Written down rather than inferred from the literal, for one reason: the press
 * is handed the event, and every handler here but one ignores it. Left to
 * inference the array's `run` is a union of signatures, and a union whose
 * narrowest member takes no arguments cannot be called with one at all — so the
 * one control that reads Shift off the press would take the whole row down with
 * it.
 */
interface Action {
  id: string
  /** A ref where the sentence depends on a setting — see `sortLabel`. */
  label: MaybeRef<string>
  icon: Component
  enabled: ComputedRef<boolean>
  /** Null is a control that is here to be seen and not yet pressed. */
  run: ((event: MouseEvent) => void) | null
}

const ACTIONS: Action[] = [
  {
    id: 'sort',
    // Spelt out like `transpose`'s, and for the same reason: the Shift half is
    // not discoverable by pressing, so the label is the only place it can live.
    label: sortLabel,
    icon: ArrowUpDownIcon,
    enabled: computed(() => blocks.value.length > 1),
    run: sortIntoReadingOrder,
  },
  {
    id: 'merge',
    label: 'Merge selected',
    icon: SquaresUniteIcon,
    enabled: canMerge,
    run: () => run(merge),
  },
  {
    id: 'split',
    label: 'Split selected',
    icon: SquareSplitHorizontalIcon,
    enabled: canSplit,
    run: () => run(split),
  },
  {
    id: 'transpose',
    // The long way round on purpose. Every part of this is something a reader
    // would otherwise have to find out by pressing it: that the box stays put,
    // that only the words turn, which way, how to go the other way, and that
    // four presses is the whole circle. The old label said "swap width and
    // height", which is now both wrong and the thing people were surprised by.
    label: 'Transpose selected — turn the lettering a quarter clockwise without moving the box. Shift for anticlockwise; four presses come full circle',
    // A square with a quarter-turn arrow: the box stays a box, and something
    // about it turns. Deliberately not a flip glyph — every mirror icon lucide
    // has says the art is about to be reversed, and nothing here is reversed.
    // It replaces `RatioIcon`, two nested rectangles, which read as "change the
    // proportions" and described the version of this that moved the box.
    icon: RotateCwSquareIcon,
    enabled: computed(() => selection.value.length > 0),
    run: transpose,
  },
  {
    id: 'garbage',
    label: 'Mark as garbage',
    icon: MessageCircleXIcon,
    enabled: computed(() => selection.value.length > 0),
    run: markGarbage,
  },
]
</script>

<template>
  <div>
    <!--
      Gone entirely until there is something to act on. Every control here needs
      a block — sorting, merging, splitting, turning, marking rubbish, sweeping
      it up — so on a page nobody has read yet the whole bar was six disabled
      icons above the words "nothing found on this page yet", which says the
      same thing twice and says it worse the second time.

      Hidden rather than disabled, unlike the individual buttons: a control that
      is greyed out is a promise that it will light up when the *selection* is
      right, which is a fair thing to say about Merge. A bar that cannot do
      anything at all is not making that promise about anything.

      Wraps, because a column is only as wide as the dock lets it be and this
      bar is several controls with a fixed width each. Held on one line it was
      the widest thing in the panel, so it set the panel's width and pushed the
      right-hand end of itself out of the column — the sweep button, the one
      control here that throws anything away, was the part that went missing.
      Wrapping costs a second row at narrow widths and nothing at all above them.
    -->
    <div v-if="blocks.length" class="mb-2 flex flex-wrap gap-2">
      <!--
        The tooltip replaces the `title` rather than joining it: a native title
        appears a second after the one we drew, over the top of it, saying the
        same thing twice in two different boxes.

        `as-child` matters here — the group joins its buttons into one control
        with rules about which of its children is first and last, so the button
        has to stay the child. The tooltip's root draws nothing itself, and the
        trigger hands its behaviour to the button rather than wrapping it.
      -->
      <UButtonGroup>
        <UTooltip v-for="action in ACTIONS" :key="action.id">
          <UTooltipTrigger as-child>
            <UButton
              variant="outline"
              size="icon-sm"
              :aria-label="toValue(action.label)"
              :disabled="!action.run || !action.enabled.value"
              @click="action.run?.($event)"
            >
              <component :is="action.icon" class="size-4" />
            </UButton>
          </UTooltipTrigger>
          <UTooltipContent>{{ toValue(action.label) }}</UTooltipContent>
        </UTooltip>
      </UButtonGroup>

      <UButtonGroup>
        <UTooltip>
          <UTooltipTrigger as-child>
            <UButton
              variant="outline"
              size="sm"
              class="hover:bg-destructive text-destructive hover:text-white"
              :disabled="!garbage"
              :aria-label="`Discard ${garbage} blocks marked garbage`"
              @click="discardGarbage"
            >
              <MessageCircleXIcon class="size-4" /> {{ garbage }}
            </UButton>
          </UTooltipTrigger>
          <!--
            A disabled button fires no pointer events, so its trigger never
            hears one and the tooltip never opens — which is why the count is
            on the face of it as well. Nought is still worth saying.
          -->
          <UTooltipContent>
            {{ garbage ? `Discard ${garbage} block(s) marked garbage` : 'Nothing marked garbage' }}
          </UTooltipContent>
        </UTooltip>
      </UButtonGroup>
    </div>

    <!--
      Said here rather than as a toast: the reason a merge was refused is about
      the rows right below it, and a message that floats away takes the context
      with it. Cleared by the next thing tried.
    -->
    <p v-if="failure" class="text-destructive mb-2 text-[11px]">
      {{ failure }}
    </p>

    <p v-if="!blocks.length" class="text-muted-foreground py-1 text-xs">
      Nothing found on this page yet.
    </p>

    <!--
      The rows are spaced the way the layer panel's are, because they are rows
      of the same page said twice: a block here and the block filed under its
      plate over there are one object, and two lists that stated it in two
      rhythms read as two different kinds of thing.

      Each row carries its own `min-w-0`, which is not the same one the reading
      inside it has and does not do the same job. A grid item's automatic
      minimum is its min-content width, and a row's min-content is its longest
      unbroken line — so the one auto column here was sized to the longest
      reading on the page rather than to the panel, and every row was laid out
      that wide. A page with a long line came out 449 pixels of row in 326
      pixels of list: the reading ran under the edge of the dock, and the type
      badge and the two buttons after it were off the panel entirely.

      The `min-w-0` inside the row is what makes the reading ellipsize once the
      row is the right width. This one is what lets the row be the right width
      at all. Neither substitutes for the other.
    -->
    <div class="grid gap-0.5">
      <PanelBlockListRow
        v-for="(block, i) in blocks"
        :key="block.id"
        :block="block"
        :index="i"
        :selected="chosen.has(block.id)"
        :pickable="blockPickable(block)"
        :dragging="dragId === block.id"
        :edge="edgeAt(i)"
        :scanned="!!page?.scan"
        :reading="reading"
        :typing="typeMenu && typeFor?.id === block.id"
        @pick="onPick"
        @hide="onHide"
        @type="openType"
        @reread="onReread"
        @remove="onRemove"
        @dragstart="onDragStart"
        @dragover="onDragOver"
        @drop="onDrop"
        @dragend="endDrag"
      />
    </div>

    <!--
      The block type menu, for every row at once — see `typeMenu`. No trigger:
      it is opened by the row that was pressed and drawn against that row's
      button.

      Keyed by the row, and the key is load-bearing. Reka's content hands its
      props down through `useForwardProps`, which only forwards a prop it saw
      set when it was made — so a `reference` that arrived after the content
      was mounted, as this one always does, never reached the popper, and the
      menu opened at its parking place above the window. Made again per row, it
      is made with its anchor.
    -->
    <UDropdownMenu v-model:open="typeMenu">
      <UDropdownMenuContent
        :key="typeFor?.id"
        class="w-40"
        :reference="typeFor?.anchor"
        @interact-outside="onTypeOutside"
        @close-auto-focus="onTypeClosed"
      >
        <UDropdownMenuLabel>Block Type</UDropdownMenuLabel>
        <UDropdownMenuGroup>
          <UDropdownMenuItem @select="setType('bubble')">
            Bubble
            <UDropdownMenuShortcut>B</UDropdownMenuShortcut>
          </UDropdownMenuItem>
          <UDropdownMenuItem @select="setType('caption')">
            Caption
            <UDropdownMenuShortcut>C</UDropdownMenuShortcut>
          </UDropdownMenuItem>
          <UDropdownMenuItem @select="setType('sfx')">
            SFX
            <UDropdownMenuShortcut>X</UDropdownMenuShortcut>
          </UDropdownMenuItem>
          <UDropdownMenuItem @select="setType('garbage')">
            Garbage
            <UDropdownMenuShortcut>G</UDropdownMenuShortcut>
          </UDropdownMenuItem>
        </UDropdownMenuGroup>
      </UDropdownMenuContent>
    </UDropdownMenu>
  </div>
</template>
