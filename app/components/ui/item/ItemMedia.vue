<script setup lang="ts">
import { itemMediaVariants } from '.'

import type { ItemMediaVariants } from '.'
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = defineProps<{
  class?: HTMLAttributes['class']
  variant?: ItemMediaVariants['variant']
}>()
</script>

<template>
  <div
    data-slot="item-media"
    :data-variant="props.variant"
    :class="cn(itemMediaVariants({ variant }), props.class)"
  >
    <slot />
  </div>
</template>
