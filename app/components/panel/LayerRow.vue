<script setup lang="ts">
/**
 * One row of the layer stack, and — if it is a group — the rows under it.
 *
 * Recursive rather than flattened, because a group is drawn as containing its
 * children and not merely above them: the twirl hides them, the indent belongs
 * to them, and both fall out of the nesting for nothing. `depth` is only ever
 * used for the indent.
 */
import { ChevronDownIcon, ChevronRightIcon, CornerRightDownIcon, EyeIcon, EyeOffIcon, LockIcon, LockOpenIcon, SlidersHorizontalIcon, SquareIcon } from '@lucide/vue'

/*
 * Desktop: named, so the `<PanelLayerRow>` below that draws this row's children
 * resolves to this file. Nuxt registers every component globally under that
 * name; here they are imported where used, and the importer does not import a
 * file into itself — Vue's own self-reference knows only the filename,
 * `LayerRow`. Unnamed, every group drew its rows as an unknown element:
 * nothing, without a warning anybody would see.
 */
defineOptions({ name: 'PanelLayerRow' })

const props = defineProps<{ layer: StackLayer, depth: number }>()

const {
  page, layerSelection, setLayer, setLayerVisible, setLayerLocked, layerEditable,
  layerDrag, moveLayer, endLayerDrag, beginEyeDrag, sweepEye, clipTarget,
} = useComic()

/**
 * What this row is clipped to, if it is clipped at all.
 *
 * Null covers two different states and the row tells them apart: not clipped,
 * and clipped to nothing — a clipped row at the bottom of its list has no base
 * and so adjusts nothing. Saying that out loud beats leaving a control that
 * quietly does nothing.
 */
const clip = computed(() => (props.layer.clipped ? clipTarget(props.layer.id) : null))

const dangling = computed(() => Boolean(props.layer.clipped && !clip.value))

/**
 * How far the row is set in: one step per level of nesting, and nothing else.
 *
 * A clipped row used to be nudged in as well, which said the wrong thing twice
 * over. It is not a child of the layer below it — it sits beside it, in the
 * same list — and indenting it moved its icon out of the column every other
 * row at its level keeps one in, so a stack could no longer be read down a
 * straight edge. The clip is said at the other end of the row instead, where
 * it costs the grid nothing.
 */
const indent = computed(() => props.depth * TREE_STEP)

/** Where this row's children hang their guide line — see `guideAt`. */
const guide = computed(() => guideAt(indent.value))

/**
 * The page's blocks that live on this row's plate, if it has one.
 *
 * Worked out from whatever page is open rather than kept in the stack — see
 * `PanelBlockRow`, where the argument is. Every block keeps the number it has
 * everywhere else, which is its place in the page's own reading order and not
 * its place in this sub-list, so the third dialogue balloon does not become
 * "1" here and "3" in the Blocks panel.
 */
const blocks = computed(() => {
  if (!props.layer.plate) return []

  return (page.value?.blocks ?? [])
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => plateOf(block) === props.layer.plate)
})

/**
 * Whether this row twirls open, and over what.
 *
 * A group twirls over its own rows; a plate that holds blocks twirls over the
 * page's. Shut by default in the second case, because a chapter page carries
 * dozens of blocks and a stack that opened into forty rows would stop being a
 * view of how the page is built.
 */
const twirls = computed(() => Boolean(props.layer.children || blocks.value.length))

/**
 * Where a row let go over this one would land.
 *
 * A group has three answers rather than two — above it, below it, or into it —
 * so it gives its middle half to "into" and a quarter to each edge. A leaf has
 * nothing to put anything inside of, so it splits down the middle.
 *
 * The edges are kept narrow on purpose: a group is the thing you are most often
 * aiming at, and a group whose edges reached halfway would be one you could
 * only drop *beside*.
 */
function zoneAt (event: DragEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const through = (event.clientY - box.top) / box.height

  if (!props.layer.children) return through < 0.5 ? 'before' : 'after'
  if (through < 0.25) return 'before'
  if (through > 0.75) return 'after'

  return 'inside'
}

function onDragStart (event: DragEvent) {
  layerDrag.value = { id: props.layer.id, over: null, where: null }

  if (!event.dataTransfer) return

  // Firefox starts no drag at all from an empty transfer.
  event.dataTransfer.setData('text/plain', props.layer.id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver (event: DragEvent) {
  if (!layerDrag.value.id || layerDrag.value.id === props.layer.id) return

  // Without this the browser reads the row as refusing the drop.
  event.preventDefault()
  // A group's children are rows of their own, and each is asked in turn as the
  // pointer passes over it; without this the group would answer for them too.
  event.stopPropagation()

  layerDrag.value = { ...layerDrag.value, over: props.layer.id, where: zoneAt(event) }
}

function onDrop (event: DragEvent) {
  const { id, over, where } = layerDrag.value

  if (!id || !over || !where) return

  event.preventDefault()
  event.stopPropagation()
  moveLayer(id, over, where)
  endLayerDrag()
}

/** What this row shows about a drop that would land on it. */
const mark = computed(() => (layerDrag.value.over === props.layer.id ? layerDrag.value.where : null))

/*
 * The eye is worked by the pointer rather than by clicks, because a sweep down
 * the column is one gesture and clicks only ever arrive one row at a time — the
 * row you press on never hears about the ones you pull across. `beginEyeDrag`
 * decides the state, `sweepEye` puts every row after it into that same state;
 * see `setLayerVisible` for why it is set and not toggled.
 *
 * Preventing the default on the press is what keeps the row's own drag — the one
 * that reorders the stack — from starting under the eye. They are different
 * gestures over the same pixels, and the eye is the one on top.
 */
function onEyePointerDown (event: PointerEvent) {
  // Pointer capture would send every later `pointerenter` to this row, which is
  // exactly the one thing a sweep must not do.
  event.preventDefault()
  beginEyeDrag(props.layer.id)
}

/**
 * The keyboard's way in. A click from a key carries no detail count, which is
 * how it is told apart from the one the browser sends after a press the sweep
 * has already dealt with — acting on that would put the row straight back.
 */
function onEyeClick (event: MouseEvent) {
  if (event.detail === 0) setLayerVisible(props.layer.id, !props.layer.visible)
}

/**
 * A row's lock: whether it is shut, and whether the lock is its own or one it
 * inherits from the group it sits in. An inherited lock is shown but not
 * clickable — the group holding it is the one to open.
 */
const lock = computed(() => ({
  shut: !layerEditable(props.layer.id),
  own: !!props.layer.locked,
}))
</script>

<template>
  <!--
    A row and whatever hangs under it, spaced the same as the rows around it.
    The gap is on every level rather than only the outermost, or the stack
    would breathe at the top and be packed solid everywhere a group opened.
  -->
  <div class="grid gap-0.5">
    <!-- `min-w-0` on the row for the reason the block list carries it — see `Blocks.vue`. -->
    <div
      draggable="true"
      class="hover:bg-accent group/row relative flex min-w-0 cursor-grab items-center gap-1.5 rounded-sm py-1 pr-2 text-sm active:cursor-grabbing"
      :class="[
        layerSelection === layer.id && 'bg-accent',
        !layer.visible && 'opacity-50',
        layerDrag.id === layer.id && 'opacity-40',
        mark === 'inside' && 'ring-primary bg-primary/10 ring-1',
      ]"
      @click="layerSelection = layer.id"
      @dragstart.stop="onDragStart"
      @dragover="onDragOver"
      @drop="onDrop"
      @dragend="endLayerDrag"
    >
      <!--
        Over the row rather than between the rows, so that aiming at a line does
        not move the rows under the pointer. Dropping *into* a group is marked
        by ringing the whole row instead — it is not a gap, so a line drawn at
        an edge would be saying the wrong thing.
      -->
      <div
        v-if="mark === 'before' || mark === 'after'"
        class="bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full"
        :class="mark === 'before' ? 'top-0' : 'bottom-0'"
      />
      <!--
        The eye leads, ahead of the twirl and outside the indent, so that every
        row's eye is in the same column however deep in the stack it sits. That
        is what makes a sweep down the column possible at all: indented eyes
        wander out from under a straight pull, and the rows a drag was aimed at
        are exactly the nested ones it would miss. Depth is carried by the name
        instead, which is the one thing in the row that is free to move.
      -->
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground ml-1 flex-none"
        :aria-label="`${layer.visible ? 'Hide' : 'Show'} ${layer.label}`"
        :aria-pressed="layer.visible"
        :title="`${layer.visible ? 'Hide' : 'Show'} ${layer.label} — drag down the column for several`"
        @pointerdown.stop="onEyePointerDown"
        @pointerenter="sweepEye(layer.id)"
        @click.stop="onEyeClick"
      >
        <EyeIcon v-if="layer.visible" class="size-4" />
        <EyeOffIcon v-else class="size-4" />
      </button>

      <!--
        One column for whatever marks the row: the twirl on a group or on a
        plate that holds blocks, the kind on an adjustment, the number on a
        block — see `PanelBlockRow`, which keeps the same slot. Fixed width and
        always drawn, which is the whole point: without it a name started
        wherever its own marker happened to leave it, so one nesting level
        began in three different columns depending on the kind of row.

        An adjustment says what it is here, because it is the one row that is
        not a picture: it draws nothing itself and instead changes what paints
        below it, and a stack where that is invisible is one where an
        odd-looking page has no obvious culprit. A clipped one wears the arrow
        at rest rather than only under a held modifier — the point of clipping
        is that the reach is no longer where the row *sits*, and a stack that
        only admitted that while you held Alt would be one to interrogate.
      -->
      <span class="flex size-4 flex-none items-center justify-center" :style="{ marginLeft: `${indent}px` }">
        <button
          v-if="twirls"
          type="button"
          class="text-muted-foreground hover:text-foreground"
          :aria-label="layer.open ? 'Collapse group' : 'Expand group'"
          :aria-expanded="layer.open"
          @click.stop="setLayer(layer.id, { open: !layer.open })"
        >
          <ChevronDownIcon v-if="layer.open" class="size-3.5" />
          <ChevronRightIcon v-else class="size-3.5" />
        </button>
        <SlidersHorizontalIcon
          v-else-if="layer.adjust"
          class="size-3"
          :class="dangling ? 'text-destructive' : 'text-muted-foreground'"
        />
        <!-- Somebody's own sheet: an empty square, which is what it is. -->
        <SquareIcon v-else-if="layer.paint" class="text-muted-foreground size-3" />
        <!--
          And a plate with nothing under it still marks itself, because the
          column only aligns a tree if every row puts something in it. These
          three — the mask, the repair, the scan — were the only rows leaving
          it empty, so they alone began at their name while every one of their
          siblings began at an icon or a number, and the group they sit in
          looked indented differently from the one next to it. A leaf has no
          twirl to give and no kind worth naming twice; a dot is the whole of
          what it has to say.
        -->
        <span v-else class="bg-muted-foreground/40 size-1 rounded-full" />
      </span>

      <span
        class="min-w-0 flex-1 truncate"
        :class="layer.children && 'font-medium'"
        :title="dangling
          ? 'Clipped to nothing — there is no layer below it'
          : clip
            ? `Clipped to ${clip.label}`
            : layer.hint"
      >
        {{ layer.label }}
      </span>

      <!--
        How many blocks are filed here, said on the row rather than only inside
        it: the count is the useful half of opening the twirl, and a plate that
        says "6" answers "where did that balloon go" without being opened at
        all.
      -->
      <span
        v-if="blocks.length"
        class="text-muted-foreground/70 flex-none font-mono text-[10px] tabular-nums"
      >
        {{ blocks.length }}
      </span>

      <!--
        That the row is clipped, said at the end rather than by moving the row.
        An adjustment keeps its own icon in the marker column with everything
        else at its level — what is unusual about it is not *where it sits* but
        *how far it reaches*, and the reach belongs beside the other things
        this row does rather than in the column that says how deep it is.

        Mirrored from the one Photoshop draws, because it is on the other side
        now: it turns down towards the layer it has taken hold of.
      -->
      <CornerRightDownIcon
        v-if="layer.clipped"
        class="size-3 flex-none"
        :class="dangling ? 'text-destructive' : 'text-muted-foreground'"
        :aria-label="dangling ? 'Clipped to nothing' : `Clipped to ${clip?.label}`"
      />

      <!--
        The other half of the eye: the eye says whether a layer is on the page,
        the lock whether it can be worked on. Shown only once it means something —
        a column of open padlocks down an untouched stack is noise.
      -->
      <button
        v-if="!layer.adjust"
        type="button"
        class="flex-none focus-visible:opacity-100"
        :class="lock.shut
          ? 'text-foreground'
          : 'text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/row:opacity-100'"
        :disabled="layer.fixed || (lock.shut && !lock.own)"
        :aria-label="`${lock.own ? 'Unlock' : 'Lock'} ${layer.label}`"
        :aria-pressed="lock.shut"
        :title="layer.fixed
          ? 'Part of the page itself — always locked'
          : lock.shut && !lock.own
            ? 'Held by the lock on the group above'
            : lock.own
              ? `Unlock ${layer.label}`
              : `Lock ${layer.label} — leave it on the page but shut to every tool`"
        @click.stop="setLayerLocked(layer.id, !lock.own)"
      >
        <LockIcon v-if="lock.shut" class="size-3.5" />
        <LockOpenIcon v-else class="size-3.5" />
      </button>
      <span class="text-muted-foreground w-8 flex-none text-right font-mono text-[11px] tabular-nums">
        {{ layer.opacity }}%
      </span>
    </div>

    <!--
      What is under this row, behind a line drawn down from its own marker.

      The line is what carries the nesting. Indentation alone had to say it,
      and indentation is a weak signal once rows at the same level carry
      different markers — a block began at its number and the Mask row at its
      name, so one looked shallower than the other despite being siblings. A
      line is unambiguous however the rows under it are furnished, which is
      also why nothing has to be pushed further right to be legible.
    -->
    <div v-if="layer.open" class="relative grid gap-0.5">
      <span
        class="bg-border pointer-events-none absolute inset-y-0 w-px"
        :style="{ left: `${guide}px` }"
      />

      <PanelLayerRow
        v-for="child in layer.children ?? []"
        :key="child.id"
        :layer="child"
        :depth="depth + 1"
      />

      <!--
        And the blocks on this plate. They are not rows of the stack and are
        drawn by a component that knows it — see `PanelBlockRow`.
      -->
      <PanelBlockRow
        v-for="entry in blocks"
        :key="entry.block.id"
        :block="entry.block"
        :index="entry.index"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>
