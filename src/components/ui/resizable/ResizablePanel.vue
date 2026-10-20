<script setup lang="ts">
import { SplitterPanel, useForwardExpose, useForwardPropsEmits } from 'reka-ui'

import type { SplitterPanelEmits, SplitterPanelProps } from 'reka-ui'

const props = defineProps<SplitterPanelProps>()
const emits = defineEmits<SplitterPanelEmits>()

const forwarded = useForwardPropsEmits(props, emits)
// Destructured and bound below: without the ref, `useForwardExpose` passes on
// the props and the element but not the panel's own `collapse` / `expand`,
// which is the whole of how a dock is put away from outside it.
const { forwardRef } = useForwardExpose()
</script>

<template>
  <SplitterPanel
    v-slot="slotProps"
    :ref="forwardRef"
    data-slot="resizable-panel"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </SplitterPanel>
</template>
