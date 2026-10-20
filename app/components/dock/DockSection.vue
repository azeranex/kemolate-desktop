<script setup lang="ts">
import { GripVerticalIcon } from '@lucide/vue'

/**
 * A section as it sits in a dock: its accordion item, the grip that picks it
 * up, and the line showing where it would land.
 *
 * `draggable` is switched on by the grip rather than left on. With it always
 * set, every press on the header — including the one that means "open this" —
 * turns into a drag as soon as the pointer moves a few pixels, and the section
 * becomes something you can only open by being careful.
 */
const props = defineProps<{
  section: PanelSection
  /** The edge to draw the insertion line on, if the drop would land here. */
  edge?: 'top' | 'bottom' | null
}>()

const { dragging, endDrag } = usePanelDock()

const armed = ref(false)

// A press that wanders off the grip and ends somewhere else never gets its
// `pointerup`, and would otherwise leave the whole section armed.
useEventListener(window, 'pointerup', () => { armed.value = false })

function onDragStart (event: DragEvent) {
  dragging.value = props.section.id

  if (!event.dataTransfer) return

  // Firefox starts no drag at all from an empty transfer.
  event.dataTransfer.setData('text/plain', props.section.id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd () {
  armed.value = false
  endDrag()
}
</script>

<template>
  <!--
    `.self` because a drag event carries up from wherever it began, and the
    things inside a section are draggable too — a block being moved up its own
    reading order, a layer being moved down its stack. Each of those reached
    this handler on the way past and was taken for the section itself being
    lifted: the docks lit up offering somewhere to drop it, and the panel the
    row lives in faded as though it were leaving.

    A drag of the section proper is fired at the section, so this still hears
    its own — see the note above `armed`, which decides when there is one.
  -->
  <UAccordionItem
    :value="section.id"
    :data-panel-section="section.id"
    :draggable="armed"
    class="relative"
    :class="dragging === section.id && 'opacity-40'"
    @dragstart.self="onDragStart"
    @dragend.self="onDragEnd"
  >
    <!--
      Drawn over the section rather than between the sections: a line that took
      up space of its own would shove everything below it down by two pixels
      each time the drop moved, under a pointer trying to aim at it.
    -->
    <div
      v-if="edge"
      class="bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full"
      :class="edge === 'top' ? 'top-0' : 'bottom-0'"
    />

    <!--
      The inset lives here rather than on the column, so that the line under a
      section runs the full width of the dock while its heading and its
      contents keep their margin — the sections read as bands of the column
      instead of as a list floating inside one.
    -->
    <UAccordionTrigger class="px-3">
      <span class="flex items-center gap-2">
        <GripVerticalIcon
          class="text-muted-foreground -ml-1.5 size-4 cursor-grab active:cursor-grabbing"
          @pointerdown="armed = true"
          @pointerup="armed = false"
          @click.stop.prevent
        />
        <component :is="section.icon" class="size-4 text-neutral-500" />
        {{ section.label }}
      </span>
    </UAccordionTrigger>

    <UAccordionContent class="px-3">
      <component :is="section.component" />
    </UAccordionContent>
  </UAccordionItem>
</template>
