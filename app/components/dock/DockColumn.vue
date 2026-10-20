<script setup lang="ts">
import { ChevronsLeftIcon, ChevronsRightIcon } from '@lucide/vue'

/**
 * One column of a dock, in whichever of its two states it is in: the sections
 * stacked open, or squeezed down to a rail of icons.
 *
 * Compacting is a property of the column rather than of the dock, so a panel
 * can be kept to hand as a strip of icons while the column next to it stays
 * open — which is the point of having more than one column at all.
 *
 * The chevrons point the way the content would travel: on the right-hand dock
 * a column folds away to the right, on the left-hand dock to the left, so the
 * button reads the same as the movement it causes.
 *
 * That button sits halfway down the edge the column faces the canvas across,
 * rather than in a bar along the top. A column is a tall thing and its edge is
 * where the pointer already is on the way to resizing it, so the control that
 * folds it away is put where the hand is rather than at a corner the eye has
 * to go looking for — and the bar it used to need is thirty-two pixels of
 * every column given back to the panels.
 */
const props = defineProps<{
  side: DockSide
  column: DockColumn
  /** The edge to draw a new-column line on, if the drop would land beside. */
  columnEdge?: 'left' | 'right' | null
}>()

const { dropTarget, opened, sectionsOf, toggleCompact } = usePanelDock()

const sections = computed(() => sectionsOf(props.column))

/**
 * The way the column would travel if the button were pressed: away from the
 * canvas to fold up, back towards it to open out.
 */
const folds = computed(() => {
  if (props.side === 'left') return props.column.compact ? 'right' : 'left'

  return props.column.compact ? 'left' : 'right'
})

/** Which edge of the section at `index` the insertion line belongs on. */
function sectionEdgeAt (index: number) {
  const target = dropTarget.value

  if (target?.kind !== 'section' || target.column !== props.column.id) return null
  if (target.index === index) return 'top'
  // Only the last section can be dropped past, and it draws that itself.
  if (target.index > index && index === sections.value.length - 1) return 'bottom'

  return null
}
</script>

<template>
  <!--
    No `min-width` of its own, which is what `min-w-0` is there for.

    `MIN_COLUMN_WIDTH` is a rule about what the user may drag a column *to* —
    `setDockWidth` and `resizeColumns` both hold stored widths at or above it —
    and not a rule about how narrow one may be rendered. Stated here as well, in
    pixels, it stopped being either: when the group squeezed the dock below what
    its columns add up to, the columns would not shrink to fit and ran off the
    edge of it instead, so at a window of 820 the second column's right edge sat
    190 pixels past the window with the Blocks panel on it, unreachable and
    unscrollable.

    Rendering narrower than the stored width is the intended state, not a
    degraded one — see `startResize` in `Dock.vue`, whose `scale` exists to
    convert pointer pixels back into stored widths for exactly this case.
  -->
  <div
    :data-dock-column="column.id"
    class="relative flex h-full min-h-0 min-w-0 flex-col"
    :style="column.compact
      ? { width: `${RAIL_WIDTH}px`, flex: 'none' }
      : { flexGrow: column.width, flexBasis: 0 }"
  >
    <!--
      Drawn over the column rather than between the columns: a line that took
      up width of its own would shove the whole dock sideways every time the
      drop moved, under a pointer trying to aim at it.
    -->
    <div
      v-if="columnEdge"
      class="bg-primary pointer-events-none absolute inset-y-0 z-20 w-0.5 rounded-full"
      :class="columnEdge === 'left' ? 'left-0' : 'right-0'"
    />

    <!--
      In the corner, over the sections rather than beside them: a column
      narrowed to its minimum has no width to spare for a gutter, and a control
      that only appears once there is room for one is a control nobody learns is
      there. The list below it is padded to clear it, so nothing is ever hidden
      underneath — and being out of the scrolling part, it stays put however far
      the sections are scrolled.

      The same square as a folded column's icons, because that is what it turns
      the column into and what it will sit among once it has.
    -->
    <UButton
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground hover:text-foreground absolute right-1.5 bottom-1.5 z-20 rounded-sm"
      :aria-label="`${column.compact ? 'Expand' : 'Collapse'} this column`"
      :title="column.compact ? 'Expand panel' : 'Collapse to icons'"
      @click="toggleCompact(side, column.id)"
    >
      <ChevronsLeftIcon v-if="folds === 'left'" class="size-4" />
      <ChevronsRightIcon v-else class="size-4" />
    </UButton>

    <DockRail v-if="column.compact" :side="side" :sections="sections" />

    <!--
      No padding of its own, above or to the sides: the gap at the top is the
      first section's own header padding, so it is the same gap as the one
      between any two sections rather than that plus a margin of the column's,
      and the sides are inset by each section instead — see `DockSection`. A
      column that held its sections in from the edge would draw every line
      between them short of it.
    -->
    <div v-else class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-11">
      <!--
        `type="multiple"` because these are settings rather than a choice —
        opening Align should not put away everything below it.
      -->
      <UAccordion v-model="opened" type="multiple">
        <DockSection
          v-for="(section, index) in sections"
          :key="section.id"
          :section="section"
          :edge="sectionEdgeAt(index)"
        />
      </UAccordion>
    </div>
  </div>
</template>
