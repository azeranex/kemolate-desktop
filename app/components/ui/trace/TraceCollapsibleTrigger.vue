<script setup lang="ts">
import { ChevronRightIcon } from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'

import TraceIcon from './TraceIcon.vue'

import type { CollapsibleTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/utils/cn'

const props = defineProps<CollapsibleTriggerProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <CollapsibleTrigger
    data-slot="trace-collapsible-trigger"
    v-bind="delegatedProps"
    :class="cn(
      'focus-visible:ring-ring/50 group/trace-collapsible-trigger text-muted-foreground hover:text-foreground has-[[data-status=error]]:text-destructive flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left transition-colors outline-none focus-visible:ring-3',
      props.class,
    )"
  >
    <slot />
    <TraceIcon class="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
      <ChevronRightIcon />
    </TraceIcon>
  </CollapsibleTrigger>
</template>
