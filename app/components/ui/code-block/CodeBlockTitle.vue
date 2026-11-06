<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="code-block-title"
    :class="cn('text-foreground group-data-[variant=destructive]/code-block:text-destructive min-w-0 truncate font-sans text-sm font-medium group-data-[size=sm]/code-block:text-xs [&_svg]:pointer-events-none [&_svg]:inline-block [&_svg]:align-middle [&_svg:not([class*=\'size-\'])]:size-4 group-data-[size=sm]/code-block:[&_svg:not([class*=\'size-\'])]:size-3.5 *:[svg]:me-1.5', props.class)"
  >
    <slot />
  </div>
</template>
