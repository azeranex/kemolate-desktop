<script setup lang="ts">
/**
 * The left edge of the workspace: the tools, and at the foot of them the two
 * dock toggles.
 *
 * The tools are a column of square buttons — the first thing the pointer
 * reaches for, and the only control that is always in the same place whatever
 * the page is showing.
 *
 * Separate toggles rather than a UToggleGroup: a group spends its markup
 * joining its items into one control — squared inner corners, shared borders,
 * a roving tab stop — all of which would have to be argued back out again for
 * a rail with air between its buttons. The toggles say which tool is out on
 * their own, through the pressed state a toggle already has.
 *
 * The rail owns the keyboard shortcuts too. They are the same choice the
 * buttons make, and a tool nobody can see is not one worth binding a key to.
 *
 * ## The dock toggles, and why they came down here
 *
 * They were at the top right, at the end of a header whose every other control
 * is about the *chapter* — what it is, what to run on it, who is in it. Showing
 * a panel is not about the chapter at all; it is about the shape of the window,
 * which is what this rail already is: the fixed furniture down the side that
 * does not change when you turn a page.
 *
 * Putting them at the **foot** rather than the head keeps that reading honest.
 * The rail runs top to bottom in order of how often a hand goes there, and
 * these are pressed once a session; at the top they would have pushed the
 * pointer's first target down by two buttons for the sake of a control nobody
 * reaches for twice.
 *
 * Two groups rather than one, each with its own label, because a screen reader
 * being told a panel toggle is a tool is being told something false. The outer
 * element is therefore the column and carries no role of its own.
 *
 * What it cost: `shown` used to be local state in the workspace layout, three
 * components away from here. It is `usePanelDock`'s now — see the note there,
 * which is also the argument for why that is where it belonged anyway.
 */
import { PanelLeftIcon, PanelRightIcon } from '@lucide/vue'

const { tool, setTool } = useTools()
const { shown, toggle } = usePanelDock()

useToolShortcuts()
</script>

<template>
  <div class="border-border bg-card flex w-13 flex-none flex-col items-center gap-0.5 border-r py-2">
    <div role="group" aria-label="Tools" class="flex flex-col items-center gap-0.5">
      <template v-for="(group, index) in TOOL_GROUPS" :key="index">
        <USeparator v-if="index" class="my-1.5 w-6.5" />

        <UTooltip v-for="t in group" :key="t.id">
          <UTooltipTrigger as-child>
            <UToggle
              size="sm"
              :model-value="tool === t.id"
              :aria-label="t.label"
              class="aria-pressed:text-primary w-8 px-0"
              @update:model-value="setTool(t.id)"
            >
              <component :is="t.icon" class="size-4.25" />
            </UToggle>
          </UTooltipTrigger>
          <UTooltipContent side="right" class="flex items-center gap-1.5">
            {{ t.label }}
            <UKbd>{{ t.key }}</UKbd>
          </UTooltipContent>
        </UTooltip>
      </template>
    </div>

    <!--
      The gap, so the toggles sit at the bottom of however tall the window is
      rather than under the last tool. `min-h-4` so they are never flush against
      the tools on a short window — a rail that ran out of room would otherwise
      put a panel toggle where the hand expects the last tool.
    -->
    <div class="min-h-4 flex-1" />

    <div role="group" aria-label="Panels" class="flex flex-col items-center gap-0.5">
      <USeparator class="mb-1.5 w-6.5" />

      <UTooltip v-for="side in DOCK_SIDES" :key="side">
        <UTooltipTrigger as-child>
          <UButton
            variant="ghost"
            size="icon-sm"
            class="w-8"
            :class="!shown[side] && 'text-muted-foreground'"
            :aria-pressed="shown[side]"
            :aria-label="`${shown[side] ? 'Hide' : 'Show'} ${side} panel`"
            @click="toggle(side)"
          >
            <PanelLeftIcon v-if="side === 'left'" class="size-4.25" />
            <PanelRightIcon v-else class="size-4.25" />
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent side="right">{{ shown[side] ? 'Hide' : 'Show' }} {{ side }} panel</UTooltipContent>
      </UTooltip>
    </div>
  </div>
</template>
