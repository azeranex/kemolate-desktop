<script setup lang="ts">
import { codeBlockVariants } from '.'

import type { CodeBlockVariants } from '.'
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = withDefaults(defineProps<{
  variant?: CodeBlockVariants['variant']
  size?: 'default' | 'sm'
  class?: HTMLAttributes['class']
}>(), {
  variant: 'default',
  size: 'default',
})
</script>

<template>
  <div
    data-slot="code-block"
    :data-variant="variant"
    :data-size="size"
    :class="cn(codeBlockVariants({ variant }), props.class)"
  >
    <slot />
  </div>
</template>
