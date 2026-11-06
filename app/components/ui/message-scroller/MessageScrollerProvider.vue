<script setup lang="ts">
import { provideMessageScroller } from './useMessageScroller'

import type { MessageScrollerProviderProps } from './useMessageScroller'

const props = defineProps<MessageScrollerProviderProps>()

provideMessageScroller(props)
</script>

<template>
  <slot />
</template>
