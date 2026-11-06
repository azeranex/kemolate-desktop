<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <span
    data-slot="trace-title"
    :class="cn('motion-reduce:shimmer-none min-w-0 truncate', props.class)"
  >
    <slot />
  </span>
</template>
