<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core'
import { AlertDialogAction } from 'reka-ui'

import type { ButtonVariants } from '@/components/ui/button'
import type { AlertDialogActionProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/utils/cn'

const props = withDefaults(
  defineProps<AlertDialogActionProps & {
    class?: HTMLAttributes['class']
    variant?: ButtonVariants['variant']
    size?: ButtonVariants['size']
  }>(),
  {
    variant: 'default',
    size: 'default',
  },
)

const delegatedProps = reactiveOmit(props, 'class', 'variant', 'size')
</script>

<template>
  <AlertDialogAction
    data-slot="alert-dialog-action"
    v-bind="delegatedProps"
    :class="cn('', buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </AlertDialogAction>
</template>
