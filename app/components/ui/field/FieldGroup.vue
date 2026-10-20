<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/utils/cn'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  /**
   * How tightly the fields inside are set — see the `[data-density]` rules in
   * `assets/css/tailwind.css`, which is where the two looks are described.
   *
   * `form` is shadcn's own, and is right where a label and its description are
   * the content: a dialog, a popover, the sign-in page. `panel` is the docked
   * inspector's — a small uppercase marker over a control, tight enough that a
   * narrow column can hold a dozen groups without becoming a scroll.
   *
   * A prop rather than a habit. It was twenty-five hand-typed
   * `text-[10px] uppercase` strings, which is how a third size crept in
   * (`text-[11px]` for a description in one panel and `text-sm` in another) —
   * a rule nobody can state in one place is a rule that drifts.
   */
  density?: 'form' | 'panel'
}>(), {
  density: 'form',
})
</script>

<template>
  <div
    data-slot="field-group"
    :data-density="density"
    :class="cn(
      'group/field-group @container/field-group flex w-full flex-col gap-7 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
