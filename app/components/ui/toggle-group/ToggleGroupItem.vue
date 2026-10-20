<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core'
import { ToggleGroupItem, useForwardProps } from 'reka-ui'
import { inject } from 'vue'

import type { VariantProps } from 'class-variance-authority'
import type { ToggleGroupItemProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { toggleVariants } from '@/components/ui/toggle'
import { cn } from '@/utils/cn'

type ToggleGroupVariants = VariantProps<typeof toggleVariants> & {
  spacing?: number
}

const props = defineProps<ToggleGroupItemProps & {
  class?: HTMLAttributes['class']
  variant?: ToggleGroupVariants['variant']
  size?: ToggleGroupVariants['size']
}>()

const context = inject<ToggleGroupVariants>('toggleGroup')

const delegatedProps = reactiveOmit(props, 'class', 'size', 'variant')
const forwardedProps = useForwardProps(delegatedProps)
</script>

<!--
  eslint-disable better-tailwindcss/enforce-canonical-classes --

  The rule wants `group-data-horizontal/toggle-group:` where this writes
  `group-data-[horizontal]/toggle-group:`, on the grounds that the short form
  means the same thing. It does not, here: the short form produces no CSS at
  all in this build, so every rounding and border rule below silently did
  nothing and the group came out square-ended with a doubled border down each
  seam. Measured either way — the long form gives 8px/0, 0/0, 0/8px and single
  seams; the short one gives 0/0 three times.
-->
<template>
  <ToggleGroupItem
    v-slot="slotProps"
    data-slot="toggle-group-item"
    :data-variant="context?.variant || variant"
    :data-size="context?.size || size"
    :data-spacing="context?.spacing"
    v-bind="forwardedProps"
    :class="cn(
      'data-[state=on]:bg-muted shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 group-data-[spacing=0]/toggle-group:shadow-none focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-[horizontal]/toggle-group:data-[spacing=0]:first:rounded-l-md group-data-[vertical]/toggle-group:data-[spacing=0]:first:rounded-t-md group-data-[horizontal]/toggle-group:data-[spacing=0]:last:rounded-r-md group-data-[vertical]/toggle-group:data-[spacing=0]:last:rounded-b-md group-data-[horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-[vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-[horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-[vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t',
      toggleVariants({
        variant: context?.variant || variant,
        size: context?.size || size,
      }),
      props.class)"
  >
    <slot v-bind="slotProps" />
  </ToggleGroupItem>
</template>
