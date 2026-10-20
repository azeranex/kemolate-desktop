<script setup lang="ts">
/**
 * A row of named stops, for a setting whose choices are points on one scale.
 *
 * Drawn inside the row of a list that has just been chosen — today that is the
 * model's effort in the Translate panel, and the padding and the swallowed
 * presses below are what that costs: to the list around it a press is picking
 * whatever row is under it, and every stop of this rail sits inside one.
 *
 * Apart from that panel rather than inside it because the markup is fiddly and
 * says nothing about translating: a slider dressed as a rail, the stops drawn
 * over its track, and the labels under it kept in step. One caller is enough
 * for that; naming the shape is the point.
 *
 * What it is *not* is a picker of unrelated things. Use it only where each
 * stop is more of the same thing than the one before it: heavier, slower,
 * surer. Where the choices merely differ, a list saying what each one is worth
 * is the honest control — which is why the detector, whose two families
 * disagree about what a box even is, is a grouped select and not this.
 */
const at = defineModel<number>({ required: true })

defineProps<{
  /** What each stop is called, in order, lightest first. */
  steps: string[]
  /** What the rail is called, for anyone not looking at it. */
  label: string
}>()

function onSlide (next: unknown) {
  const to = (next as number[] | undefined)?.[0]

  if (to !== undefined) at.value = to
}
</script>

<template>
  <!--
    The presses stop here: to the list around it a press is picking whatever
    row is under it, and every stop of this rail sits inside one.
  -->
  <div class="px-3.5 pt-0.5 pb-3" @pointerdown.stop @keydown.stop>
    <!--
      A real slider dressed as the rail, rather than three buttons that look
      like one: dragging, tapping the track, arrow keys, Home and End and a
      thumb that announces itself all come with it, and none of them are worth
      writing again by hand.
    -->
    <div class="relative flex h-5 items-center">
      <USlider
        :model-value="[at]"
        :min="0"
        :max="steps.length - 1"
        :step="1"
        :aria-label="label"
        class="**:data-[slot=slider-track]:bg-border **:data-[slot=slider-thumb]:border-popover **:data-[slot=slider-thumb]:bg-primary **:data-[slot=slider-thumb]:ring-primary **:data-[slot=slider-thumb]:size-3.5 **:data-[slot=slider-thumb]:border-2 **:data-[slot=slider-thumb]:shadow-none **:data-[slot=slider-thumb]:ring-1 **:data-[slot=slider-thumb]:hover:ring-1 **:data-[slot=slider-track]:h-0.75"
        @update:model-value="onSlide"
      />

      <!--
        The stops it snaps to, drawn over the track it lies on. The one in
        force is left out: the thumb is already sitting on it, and a dot
        underneath would only peep out from behind.
      -->
      <div class="pointer-events-none absolute inset-0 flex items-center justify-between">
        <span
          v-for="(step, index) in steps"
          :key="step"
          class="border-popover size-3.5 rounded-full border-2"
          :class="[
            index < at ? 'bg-primary' : 'bg-muted-foreground/40',
            index === at && 'invisible',
          ]"
        />
      </div>
    </div>

    <!--
      The stops name themselves and the one in force is picked out, so the
      setting is never written down twice in the same box.
    -->
    <div class="mt-1.5 flex justify-between text-center text-[10.5px] *:flex-1 *:first:text-left *:last:text-right">
      <span
        v-for="(step, index) in steps"
        :key="step"
        :class="index === at ? 'text-foreground' : 'text-muted-foreground'"
      >
        {{ step }}
      </span>
    </div>

    <!-- What the stop in force is worth, in a sentence. -->
    <p v-if="$slots.default" class="text-muted-foreground mt-2 text-[11px] leading-relaxed">
      <slot />
    </p>
  </div>
</template>
