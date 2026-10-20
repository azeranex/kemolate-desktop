<script setup lang="ts">
import { inputGroupButtonVariants } from '.'

import type { InputGroupButtonProps } from '.'

import { Button } from '@/components/ui/button'
import { cn } from '@/utils/cn'

const props = withDefaults(defineProps<InputGroupButtonProps>(), {
  size: 'xs',
  variant: 'ghost',
})
</script>

<template>
  <Button
    type="button"
    :data-size="props.size"
    :variant="props.variant"
    :class="cn(inputGroupButtonVariants({ size: props.size }), props.class)"
  >
    <slot />
  </Button>
</template>
