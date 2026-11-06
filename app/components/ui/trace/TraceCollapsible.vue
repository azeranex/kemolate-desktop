<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core'
import { useForwardPropsEmits } from 'reka-ui'

import type { CollapsibleRootEmits, CollapsibleRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { Collapsible } from '@/components/ui/collapsible'
import { cn } from '@/utils/cn'

const props = defineProps<CollapsibleRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<CollapsibleRootEmits>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <Collapsible
    v-slot="slotProps"
    data-slot="trace-collapsible"
    v-bind="forwarded"
    :class="cn('flex w-full min-w-0 flex-col', props.class)"
  >
    <slot v-bind="slotProps" />
  </Collapsible>
</template>
