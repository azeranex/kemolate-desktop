<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="code-block-header"
    :class="cn('text-muted-foreground group-data-[variant=destructive]/code-block:text-destructive flex min-w-0 shrink-0 items-center gap-2 px-4 pt-4 group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:pt-3 *:has-[>[data-slot=code-block-title]]:min-w-0', props.class)"
  >
    <slot />
  </div>
</template>
