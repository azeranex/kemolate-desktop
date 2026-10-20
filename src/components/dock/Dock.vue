<script setup lang="ts">
import { SquareDashedIcon } from '@lucide/vue'

/**
 * One side of the panel: the columns docked to this edge, side by side, and
 * all of the drop handling for the sections inside them.
 *
 * The dock decides what a drop means, rather than each column or section
 * deciding for itself. It reads the pointer against the columns once and comes
 * back with one of two answers — a gap between sections of an existing column,
 * or a gap between columns, which is a column that does not exist yet. That is
 * the whole of "drag it to the edge to pull out a new column": the edge is
 * simply the first and last of those gaps.
 *
 * Reading it in one place is also what keeps the drag alive everywhere. There
 * is no dead space between items, the room below the last section means "put
 * it at the end", and a dock with nothing in it at all is still a target.
 */
const props = defineProps<{ side: DockSide }>()

const { layout, dragging, dropTarget, moveSection, resizeColumns, endDrag } = usePanelDock()

const columns = computed(() => layout.value[props.side])

const root = useTemplateRef<HTMLElement>('root')

/**
 * How close to a column's edge counts as aiming at the gap beside it — a band
 * on each side, but never more than a third of the column, so there is always
 * a middle left to drop *into*. A compacted rail is forty-four pixels wide;
 * a fixed band would cover the whole of it, and nothing could ever be added
 * to a column once it had been folded down to icons.
 */
const EDGE = 28

function edgeOf (box: DOMRect) {
  return Math.min(EDGE, box.width / 3)
}

function columnElements () {
  return [...root.value?.querySelectorAll<HTMLElement>('[data-dock-column]') ?? []]
}

/** The gap between sections that the pointer is over, within one column. */
function sectionIndexAt (column: HTMLElement, y: number) {
  const items = [...column.querySelectorAll('[data-panel-section]')]

  for (const [index, item] of items.entries()) {
    const box = item.getBoundingClientRect()

    // Past the middle of a section is a drop below it, which is the same gap
    // as above the next one — so only the top halves need testing.
    if (y < box.top + box.height / 2) return index
  }

  return items.length
}

function targetAt (event: DragEvent): PanelDropTarget {
  const elements = columnElements()

  // Nothing here yet: the only thing a drop can mean is the first column.
  if (!elements.length) return { side: props.side, kind: 'column', index: 0 }

  /**
   * The gaps between columns, taken one boundary at a time rather than one
   * column at a time. A boundary claims a band to either side of itself, and
   * the band is the narrower of what its two columns are each willing to give
   * — so a wide column next to a folded rail cannot reach across and claim the
   * whole of the rail as "the gap beside me", which is what would stop a rail
   * from ever being dropped into.
   */
  for (let index = 0; index <= elements.length; index++) {
    const before = elements[index - 1]?.getBoundingClientRect()
    const after = elements[index]?.getBoundingClientRect()
    const at = after ? after.left : before!.right
    const band = Math.min(
      before ? edgeOf(before) : Infinity,
      after ? edgeOf(after) : Infinity,
    )

    if (Math.abs(event.clientX - at) <= band) return { side: props.side, kind: 'column', index }
  }

  const over = elements.find((element) => {
    const box = element.getBoundingClientRect()

    return event.clientX >= box.left && event.clientX <= box.right
  })

  // Off the end of the row horizontally — a last column, rather than nothing.
  if (!over) return { side: props.side, kind: 'column', index: elements.length }

  return {
    side: props.side,
    kind: 'section',
    column: over.dataset.dockColumn!,
    index: sectionIndexAt(over, event.clientY),
  }
}

function onDragOver (event: DragEvent) {
  if (!dragging.value) return

  // Without this the browser reads the dock as refusing the drop, and animates
  // the section back to where it came from.
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

  dropTarget.value = targetAt(event)
}

function onDragLeave (event: DragEvent) {
  // Crossing from one child to the next fires a leave for the one behind; only
  // the pointer actually off the dock should take the line down.
  if (root.value?.contains(event.relatedTarget as Node | null)) return

  dropTarget.value = null
}

function onDrop (event: DragEvent) {
  const id = dragging.value

  if (!id) return

  event.preventDefault()
  moveSection(id, targetAt(event))
  endDrag()
}

/**
 * Dragging the boundary between two columns.
 *
 * Measured in pixels off the two columns as they actually are, and handed on
 * as a share of the two of them — the stored widths are proportions that only
 * become pixels once the dock has been measured, so a boundary moved by what
 * the pointer moved has to be worked out against the boundary on screen.
 *
 * The pointer is captured, so a drag that outruns the two-pixel line it began
 * on keeps going, and ends on releasing wherever that happens to be.
 */
const resizing = ref<{ index: number, x: number, before: number, total: number, scale: number } | null>(null)

function startResize (index: number, event: PointerEvent) {
  const elements = columnElements()
  const before = elements[index]?.getBoundingClientRect().width
  const after = elements[index + 1]?.getBoundingClientRect().width
  const stored = (columns.value[index]?.width ?? 0) + (columns.value[index + 1]?.width ?? 0)

  if (!before || !after || !stored) return

  // Everything the drag needs, taken once and kept: where it began, and what
  // the pair was worth then, in both scales. A dock squeezed below what its
  // columns ask for renders them smaller than their stored widths, so the
  // pixels the pointer moves are worth `scale` of a stored width each.
  resizing.value = {
    index,
    x: event.clientX,
    before,
    total: stored,
    scale: stored / (before + after),
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  // A boundary drag is not a text selection, however far it wanders.
  event.preventDefault()
}

function onResize (event: PointerEvent) {
  const at = resizing.value

  if (!at) return

  resizeColumns(props.side, at.index, (at.before + event.clientX - at.x) * at.scale, at.total)
}

function endResize (event: PointerEvent) {
  if (!resizing.value) return

  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  resizing.value = null
}

/** A boundary only moves when there is an open column on both sides of it. */
function movable (index: number) {
  return !columns.value[index]?.compact && !columns.value[index + 1]?.compact
}

/** Which side of the column at `index` a new-column line belongs on. */
function columnEdgeAt (index: number) {
  const target = dropTarget.value

  if (target?.side !== props.side || target.kind !== 'column') return null
  if (target.index === index) return 'left'
  // Only the last column can be dropped past, and it draws that itself.
  if (target.index > index && index === columns.value.length - 1) return 'right'

  return null
}
</script>

<template>
  <div
    ref="root"
    class="bg-card flex size-full min-h-0"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <template v-for="(column, index) in columns" :key="column.id">
      <!--
        The line between two columns, and the grip for moving it. A line of one
        pixel is nothing to aim at, so the reach is widened either side of it by
        a child that takes no room — widening the line itself would move the
        boundary it is drawn at every time a column was added.
      -->
      <div
        v-if="index"
        class="bg-border relative z-10 w-px flex-none"
        :class="movable(index - 1) && 'hover:bg-primary cursor-col-resize'"
        @pointerdown="movable(index - 1) && startResize(index - 1, $event)"
        @pointermove="onResize"
        @pointerup="endResize"
        @pointercancel="endResize"
      >
        <div v-if="movable(index - 1)" class="absolute inset-y-0 -left-1 w-2.5" />
      </div>

      <DockColumn
        :side="side"
        :column="column"
        :column-edge="columnEdgeAt(index)"
      />
    </template>

    <!--
      A dock with no columns still has to be aimed at, so it says so and holds
      enough width to be a target rather than collapsing to a line.
    -->
    <div
      v-if="!columns.length"
      class="border-border text-muted-foreground m-3 flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 text-center text-xs"
      :class="dropTarget?.side === side && 'border-primary text-primary'"
    >
      <SquareDashedIcon class="size-5" />
      Drag a panel here
    </div>
  </div>
</template>
