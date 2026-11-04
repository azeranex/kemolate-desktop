<script setup lang="ts">
/**
 * The layer stages — Read, Clean, Letter, Final — in the title bar. Desktop.
 *
 * The same four as the Layers panel's "Working on" row and View's radio items
 * (`useLayerPresets`), put where they are one press away whatever panel is out:
 * a stage is chosen every few minutes while working through a chapter, and
 * opening the Layers panel or a menu to do it was the reader's complaint
 * (2026-10-28). One segmented row, the lit one the stage the stack is in; none
 * lit once a row has been arranged by hand.
 *
 * Gone first when the bar is squeezed (`@3xl`), since the panel and the menu
 * still have it.
 */
const { presets, active, apply, writable } = useLayerPresets()
</script>

<template>
  <div class="bg-muted hidden flex-none items-center gap-0.5 rounded-md p-0.5 @3xl:flex" role="group" aria-label="Layer stage">
    <UTooltip v-for="preset in presets" :key="preset.id">
      <UTooltipTrigger as-child>
        <UButton
          :variant="active === preset.id ? 'secondary' : 'ghost'"
          size="sm"
          :disabled="!writable"
          :aria-pressed="active === preset.id"
          class="h-7 px-2.5 text-xs"
          :class="active === preset.id ? 'bg-background shadow-xs' : 'text-muted-foreground'"
          @click="apply(preset.id)"
        >
          {{ preset.label }}
        </UButton>
      </UTooltipTrigger>
      <UTooltipContent class="max-w-64">
        {{ preset.hint }} — set on every page of the chapter. Layers you added are left alone.
      </UTooltipContent>
    </UTooltip>
  </div>
</template>
