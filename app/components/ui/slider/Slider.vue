<script setup lang="ts">
/**
 * shadcn-vue's slider, with one addition: `label`.
 *
 * Given, each thumb carries a bubble saying what it is set to — shown while
 * the slider is being dragged, and while a thumb is hovered or has keyboard
 * focus. For a slider whose value is a thing with a name — a page number —
 * rather than an amount the track already shows: dragging across fifty pages
 * with nothing saying which one you are over is guessing.
 *
 * Drawn here rather than with `UTooltip`: a tooltip opens on hover and closes
 * when the pointer leaves its trigger, and a thumb being dragged is left by
 * the pointer all the time — reka captures it on the root, not the thumb. The
 * bubble is styled as the tooltip is, and it is the thumb's own child, so it
 * follows the thumb with no positioning of its own.
 *
 * Without `label` this is the component as generated, and every slider that
 * does not pass one is untouched.
 */
import { reactiveOmit } from '@vueuse/core'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack, useForwardPropsEmits } from 'reka-ui'

import type { SliderRootEmits, SliderRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = defineProps<SliderRootProps & {
  class?: HTMLAttributes['class']
  /** What a thumb's bubble says for its value — none where this is not given. */
  label?: (value: number, index: number) => string
}>()
const emits = defineEmits<SliderRootEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'label')

const forwarded = useForwardPropsEmits(delegatedProps, emits)

/**
 * Whether a drag is under way. From the root's pointerdown to the pointer
 * coming up anywhere — the window, because a drag that ends off the slider is
 * still the end of the drag.
 */
const dragging = ref(false)

function startDrag () {
  if (!props.label) return

  dragging.value = true
  window.addEventListener('pointerup', endDrag, { once: true })
  window.addEventListener('pointercancel', endDrag, { once: true })
}

function endDrag () {
  dragging.value = false
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
}

onBeforeUnmount(endDrag)
</script>

<template>
  <SliderRoot
    v-slot="{ modelValue }"
    data-slot="slider"
    :data-vertical="props.orientation === 'vertical' ? '' : undefined"
    :data-dragging="dragging ? '' : undefined"
    :class="cn(
      'group/slider relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col',
      props.class,
    )"
    v-bind="forwarded"
    @pointerdown="startDrag"
  >
    <SliderTrack
      data-slot="slider-track"
      :data-horizontal="props.orientation !== 'vertical' ? '' : undefined"
      :data-vertical="props.orientation === 'vertical' ? '' : undefined"
      class="bg-muted relative grow overflow-hidden rounded-full data-horizontal:h-1.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-1.5"
    >
      <SliderRange
        data-slot="slider-range"
        :data-horizontal="props.orientation !== 'vertical' ? '' : undefined"
        :data-vertical="props.orientation === 'vertical' ? '' : undefined"
        class="bg-primary absolute select-none data-horizontal:h-full data-vertical:w-full"
      />
    </SliderTrack>

    <SliderThumb
      v-for="(_, key) in modelValue"
      :key="key"
      data-slot="slider-thumb"
      :data-vertical="props.orientation === 'vertical' ? '' : undefined"
      class="group/thumb border-primary ring-ring/50 relative block size-4 shrink-0 rounded-full border bg-white shadow-sm transition-[color,box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
    >
      <span
        v-if="props.label && modelValue"
        aria-hidden="true"
        class="
          bg-foreground text-background pointer-events-none absolute bottom-full
          left-1/2 mb-2 hidden -translate-x-1/2 rounded-md px-2 py-0.5 font-mono
          text-xs whitespace-nowrap tabular-nums
          group-hover/thumb:block
          group-focus-visible/thumb:block
          group-data-dragging/slider:block
        "
      >{{ props.label(modelValue[key]!, key) }}</span>
    </SliderThumb>
  </SliderRoot>
</template>
