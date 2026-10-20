<script setup lang="ts">
/**
 * The long explanation of a control, behind a small `i` beside its name.
 *
 * Popovers and panels said everything in full under every control, and the
 * explanation is read once and then scrolled past for good: the Auto popover
 * was a column of paragraphs around four switches, and one switch in the
 * Detect panel carried five lines. What stays on screen is the name and any
 * short *state* (what it is set to, why it is off); the why of it is here, on
 * hover or focus.
 *
 * A real button, so it can be reached by keyboard and the tooltip opens on
 * focus — a tooltip on a bare icon is one only a mouse can read. `label` is
 * what a screen reader announces for the button; the tooltip's text is its
 * description, which reka wires up itself.
 */
import { InfoIcon } from '@lucide/vue'

defineProps<{
  /** What the button is called — "About Learned mask". */
  label: string
}>()
</script>

<template>
  <UTooltip>
    <UTooltipTrigger as-child>
      <button
        type="button"
        class="
          text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-4
          flex-none items-center justify-center
          rounded-sm
          align-middle focus-visible:ring-2 focus-visible:outline-none
        "
        :aria-label="label"
        @click.prevent
      >
        <InfoIcon class="size-3.5" />
      </button>
    </UTooltipTrigger>
    <UTooltipContent class="block max-w-64 leading-snug">
      <slot />
    </UTooltipContent>
  </UTooltip>
</template>
