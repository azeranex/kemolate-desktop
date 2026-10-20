<script setup lang="ts">
/**
 * A compacted column: its sections as a strip of icons, each opening the panel
 * itself as a flyout beside the rail.
 *
 * The flyout floats over the canvas instead of pushing it aside, which is the
 * point of compacting — a panel can be looked at, used and dismissed without
 * the drawing ever reflowing under it. It is rendered at the body rather than
 * in place because the dock it belongs to is a resizable panel, and those clip
 * their overflow; anchored by measurement, it can hang outside that.
 *
 * Icons stay draggable. A section put away as an icon is still a section, and
 * having to expand a column just to move something out of it would make
 * compacting a thing you avoid doing.
 */
const props = defineProps<{ side: DockSide, sections: PanelSection[] }>()

const { dragging, endDrag } = usePanelDock()

const rail = useTemplateRef<HTMLElement>('rail')
const flyout = useTemplateRef<HTMLElement>('flyout')

/**
 * Shallow because a section carries the component that draws it. A plain `ref`
 * makes what it holds deeply reactive, and a reactive component is a proxy Vue
 * then has to see through on every render — which it warns about, and which is
 * pure overhead for a value that is only ever swapped whole.
 */
const open = shallowRef<PanelSection | null>(null)

const bounds = useElementBounding(rail)
const { width: viewport } = useWindowSize()

/**
 * Pinned to the rail's own edge and top, so it reads as coming out of the icon
 * that was clicked rather than as a window that happens to be nearby.
 */
const position = computed(() => ({
  top: `${bounds.top.value}px`,
  maxHeight: `${bounds.height.value}px`,
  ...props.side === 'left'
    ? { left: `${bounds.right.value}px` }
    : { right: `${viewport.value - bounds.left.value}px` },
}))

function toggle (section: PanelSection) {
  open.value = open.value?.id === section.id ? null : section
}

function onDragStart (event: DragEvent, section: PanelSection) {
  open.value = null
  dragging.value = section.id

  if (!event.dataTransfer) return

  // Firefox starts no drag at all from an empty transfer.
  event.dataTransfer.setData('text/plain', section.id)
  event.dataTransfer.effectAllowed = 'move'
}

onClickOutside(flyout, () => { open.value = null }, { ignore: [rail] })
</script>

<template>
  <div ref="rail" class="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto pt-2 pb-11">
    <UButton
      v-for="section in sections"
      :key="section.id"
      :data-panel-section="section.id"
      variant="ghost"
      size="icon-sm"
      draggable="true"
      class="cursor-grab active:cursor-grabbing"
      :class="[
        open?.id === section.id && 'bg-accent text-accent-foreground',
        dragging === section.id && 'opacity-40',
      ]"
      :title="section.label"
      :aria-label="section.label"
      :aria-expanded="open?.id === section.id"
      @click="toggle(section)"
      @dragstart="onDragStart($event, section)"
      @dragend="endDrag"
    >
      <component :is="section.icon" class="size-4" />
    </UButton>

    <Teleport to="body">
      <div
        v-if="open"
        ref="flyout"
        class="bg-card border-border fixed z-50 flex w-80 flex-col overflow-hidden rounded-md border shadow-lg"
        :style="position"
      >
        <div class="border-border flex flex-none items-center gap-2 border-b px-3 py-2 text-sm font-medium">
          <component :is="open.icon" class="size-4 text-neutral-500" />
          {{ open.label }}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <component :is="open.component" />
        </div>
      </div>
    </Teleport>
  </div>
</template>
