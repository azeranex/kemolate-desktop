<script setup lang="ts">
/**
 * A number you drag or type — what the context bar is made of.
 *
 * A slider would be the obvious control and is the wrong one here. The bar is
 * a single forty-pixel row shared with the tool's name and the page's stats,
 * and a slider needs length to be worth anything: at the width that leaves,
 * one pixel of travel is several of whatever it sets, so it can be waved at
 * but not aimed. The panel sliders this replaces spanned a whole dock column
 * to say the same thing.
 *
 * Dragging the label instead costs no width at all and has no end — the throw
 * is however far the hand goes, not however wide the control is — and the
 * number is always legible because it is a number rather than a position along
 * a track. Typing is there for when the answer is known.
 *
 * ## Drag on the label, not on the field
 *
 * The value is a text input and text inputs are for selecting text. Dragging
 * across one to change it would take the caret away from anybody who wanted to
 * edit it, so the grab handle is the label beside it, which has nothing else
 * to do.
 */
const props = withDefaults(defineProps<{
  label: string
  min: number
  max: number
  /** What one pixel of horizontal drag is worth. */
  perPixel?: number
  suffix?: string
  /** Shown after the label when the value is not the whole story. */
  title?: string
}>(), { perPixel: 1, suffix: '' })

const value = defineModel<number>({ required: true })

/** A drag: where it began and the value it began from. */
let scrub: { x: number, from: number } | null = null

/** What the field shows while it is not being typed into. */
const shown = computed(() => `${value.value}${props.suffix}`)

const held = (next: number) => Math.round(Math.min(props.max, Math.max(props.min, next)))

function onDown (event: PointerEvent) {
  if (event.button !== 0) return

  scrub = { x: event.clientX, from: value.value }
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onMove (event: PointerEvent) {
  if (!scrub) return

  value.value = held(scrub.from + (event.clientX - scrub.x) * props.perPixel)
}

function onUp () {
  scrub = null
}

/**
 * Typed in, taken on commit rather than on every keystroke.
 *
 * Reading it as it is typed would clamp `4` to the minimum on the way to `40`,
 * and there is no way to type past a clamp that has already happened.
 */
function onCommit (event: Event) {
  const field = event.target as HTMLInputElement
  const parsed = Number.parseFloat(field.value)

  if (Number.isFinite(parsed)) value.value = held(parsed)

  // Back to the canonical form either way: a rejected entry should not be left
  // sitting in the box looking accepted.
  field.value = shown.value
}
</script>

<template>
  <div class="flex items-center gap-1">
    <span
      class="text-muted-foreground hover:text-foreground cursor-ew-resize text-[10px] uppercase select-none"
      :title="title ?? `Drag to change ${label.toLowerCase()}`"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      {{ label }}
    </span>
    <input
      :value="shown"
      inputmode="numeric"
      class="border-border/60 focus:border-primary text-foreground h-6 w-13 rounded-sm border bg-transparent px-1 text-right font-mono text-[11px] tabular-nums outline-none"
      :aria-label="label"
      @change="onCommit"
      @blur="onCommit"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    >
  </div>
</template>
