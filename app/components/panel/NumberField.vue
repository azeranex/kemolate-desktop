<script setup lang="ts">
/**
 * A number in a panel: drag across it to change it, or click into it and type.
 *
 * What the Lettering panel's sliders became. A slider spends its whole length
 * on the range — 10 to 261 pixels of type across a dock column — so one pixel
 * of travel is several of whatever it sets, and a particular value could be
 * waved at but not landed on. A scrubbed number has no track: the throw is as
 * long as the hand makes it, Shift and Alt change the gearing, and the value
 * is a number you can read rather than a position you have to estimate.
 *
 * ## Two modes, told apart by focus
 *
 * The field is both a handle and a text box, and those want opposite things
 * from a drag. So it is one or the other, never both at once:
 *
 * - **Not focused — a handle.** A press is held back from the input (no caret,
 *   no selection) until it either travels, which makes it a scrub, or is let
 *   go where it started, which makes it a click: the field takes focus with its
 *   number selected, ready to be typed over.
 * - **Focused — a text box.** Pointer events are left entirely alone, so a drag
 *   selects text the way it does in any input, and the caret goes where it is
 *   clicked. Enter or leaving the field commits; Escape puts it back.
 *
 * The first version of this (and `tool/Scrub`) avoided the conflict by only
 * scrubbing on the label beside the field. That works, but the label is a
 * dozen pixels of small caps, and the obvious thing to grab — the number — did
 * nothing. The label still scrubs here too.
 *
 * ## What is emitted
 *
 * `set` with each value: every step of a scrub, and a typed value on commit,
 * never on each keystroke — a `4` on the way to `40` would otherwise be clamped
 * to the minimum, with no way to type past a clamp that has already happened.
 * The caller folds a scrub into one undo step (a merge key on the write).
 *
 * `value` null is *mixed* — several blocks that disagree — shown as an empty
 * field rather than as the first block's number, which reads as "they are all
 * this". A scrub from mixed starts at `from`.
 *
 * ## Right-click resets
 *
 * Where there is somewhere to go back to — `resettable` — a right-click goes
 * there: `reset` is emitted, and `set` too with `defaultValue` when the default
 * is a number. A value that resets to *Auto* has no number to send, which is why
 * `reset` exists at all. It is the menu a right-click would otherwise open that
 * is given up, so it is given up only when it buys something: never while
 * typing (that menu is Paste), and never on a field already at its default.
 */
const props = withDefaults(defineProps<{
  label: string
  /** The value, or null for mixed. */
  value: number | null
  suffix?: string
  /** What one pixel of drag is worth. */
  step?: number
  /** What one press of an arrow key is worth. Defaults to one unit of the last kept decimal. */
  nudge?: number
  /** Decimal places kept. */
  precision?: number
  min?: number
  max?: number
  disabled?: boolean
  /** Where a scrub starts when the value is mixed. */
  from?: number
  /** Shown in an empty field. */
  placeholder?: string
  /** The value is one the app worked out, not one somebody chose — shown dimmer. */
  automatic?: boolean
  /** Classes for the label, which is also a scrub handle. */
  labelClass?: string
  /** A word inside the field, before the number — what kind of value it is. */
  hint?: string
  /** Whether there is a default to go back to — a right-click goes there. */
  resettable?: boolean
  /** The default, when it is a number; a reset sends it as `set` as well. */
  defaultValue?: number
}>(), {
  suffix: '',
  step: 1,
  nudge: undefined,
  precision: 0,
  min: -Infinity,
  max: Infinity,
  disabled: false,
  from: undefined,
  placeholder: 'Mixed',
  automatic: false,
  labelClass: 'min-w-3 text-[10px] uppercase',
  hint: undefined,
  resettable: false,
  defaultValue: undefined,
})

const emit = defineEmits<{ set: [value: number], reset: [] }>()

const field = ref<HTMLInputElement | null>(null)

/** Whether the field has focus — which of the two modes it is in. */
const editing = ref(false)

/** A press that is not yet known to be a scrub or a click. */
let press: { id: number, x: number, from: number, scrubbing: boolean, onField: boolean } | null = null

/** How far a press may wander and still be a click. */
const SLOP = 3

const held = (next: number) => {
  const k = 10 ** props.precision

  return Math.round(Math.min(props.max, Math.max(props.min, next)) * k) / k
}

const shown = computed(() => (props.value === null ? '' : `${props.value.toFixed(props.precision)}${props.suffix}`))

/** Shift for ten times as far, Alt for a tenth — the gearing a slider cannot have. */
const gear = (event: { shiftKey: boolean, altKey: boolean }) => (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1)

/**
 * Whether a right-button press found the field being typed into — kept from the
 * press to the menu event it causes, because the press itself would otherwise
 * focus the field and every right-click would look like one made while typing.
 */
let menuWhileTyping: boolean | null = null

function onDown (event: PointerEvent, onField: boolean) {
  if (event.button === 2) {
    menuWhileTyping = editing.value

    // Held back from the input, as a left press is, so a reset does not also
    // put the field into typing with a word selected.
    if (!editing.value && props.resettable) event.preventDefault()

    return
  }

  if (event.button !== 0 || props.disabled) return

  // Typing: the field is a text box and the press is its own business.
  if (onField && editing.value) return

  press = { id: event.pointerId, x: event.clientX, from: props.value ?? props.from ?? (Number.isFinite(props.min) ? props.min : 0), scrubbing: false, onField }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  // Held back from the input: no caret, no selection, no focus — yet.
  event.preventDefault()
}

function onMove (event: PointerEvent) {
  if (!press || event.pointerId !== press.id) return

  const dx = event.clientX - press.x

  if (!press.scrubbing && Math.abs(dx) < SLOP) return

  press.scrubbing = true
  emit('set', held(press.from + dx * props.step * gear(event)))
}

function onUp (event: PointerEvent) {
  if (!press || event.pointerId !== press.id) return

  const clicked = !press.scrubbing && press.onField

  press = null

  // A press that never travelled was a click: into the field, number selected.
  if (clicked) {
    field.value?.focus()
    field.value?.select()
  }
}

function onCancel () {
  press = null
}

function onCommit () {
  const input = field.value

  if (!input) return

  const parsed = Number.parseFloat(input.value)

  if (input.value.trim() !== '' && Number.isFinite(parsed) && held(parsed) !== props.value) emit('set', held(parsed))

  // Back to the canonical form either way: a rejected entry should not sit in
  // the box looking accepted.
  input.value = shown.value
}

function onBlur () {
  editing.value = false
  onCommit()
}

function onEscape () {
  if (field.value) field.value.value = shown.value
  field.value?.blur()
}

/** Up and down step it, as a number field does. */
function onArrow (event: KeyboardEvent, direction: 1 | -1) {
  const at = props.value ?? props.from

  if (at === undefined) return

  event.preventDefault()

  const unit = props.nudge ?? 10 ** -props.precision
  const next = held(at + direction * unit * gear(event))

  emit('set', next)
  // Typed text is replaced by the stepped value, so the arrows and the digits
  // never disagree about what the field says.
  nextTick(() => {
    if (field.value) field.value.value = shown.value
  })
}

/** Back to the default — see the header for when a right-click is taken. */
function onReset (event: MouseEvent) {
  // A menu from the keyboard has no press before it; ask the field as it is.
  const typing = menuWhileTyping ?? editing.value

  menuWhileTyping = null

  if (!props.resettable || typing || props.disabled) return

  event.preventDefault()
  press = null
  emit('reset')

  if (props.defaultValue !== undefined) emit('set', held(props.defaultValue))
}

/** What hovering says the field does, so the right-click is not a secret. */
const tip = computed(() => {
  const name = props.label.toLowerCase()
  const lines = [`Drag to change ${name} — Shift for more, Alt for less. Click to type.`]

  if (props.resettable) lines.push('Right-click to reset.')

  return lines.join(' ')
})

// A new value from outside while the field is being typed into is left for the
// commit to reconcile; otherwise the box follows it.
watch(shown, (text) => {
  if (!editing.value && field.value) field.value.value = text
})
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5" :class="disabled && 'opacity-50'">
    <span
      class="hover:text-foreground flex-none cursor-ew-resize select-none"
      :class="[labelClass, resettable ? 'text-foreground' : 'text-muted-foreground']"
      :title="tip"
      @pointerdown="onDown($event, false)"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onCancel"
      @contextmenu="onReset"
    >
      {{ label }}
    </span>
    <div class="relative min-w-0 flex-1">
      <!-- Under the number and out of the pointer's way: it labels, it does not take presses. -->
      <span
        v-if="hint && !editing"
        class="text-muted-foreground/70 pointer-events-none absolute inset-y-0 left-1.5 flex items-center text-[9px] uppercase"
      >{{ hint }}</span>
      <input
        ref="field"
        :value="shown"
        :placeholder="value === null ? placeholder : ''"
        :disabled="disabled"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        class="
          border-border/60 placeholder:text-muted-foreground/60 focus:border-primary h-7 w-full min-w-0 rounded-sm
          border bg-transparent px-1.5 text-right font-mono text-[11px] tabular-nums outline-none
        "
        :class="[
          editing ? 'cursor-text' : 'hover:border-border cursor-ew-resize select-none',
          automatic && !editing ? 'text-muted-foreground' : 'text-foreground',
        ]"
        :aria-label="label"
        :title="editing ? undefined : tip"
        @pointerdown="onDown($event, true)"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onCancel"
        @contextmenu="onReset"
        @focus="editing = true"
        @blur="onBlur"
        @keydown.enter.prevent="field?.blur()"
        @keydown.esc.prevent="onEscape"
        @keydown.up="onArrow($event, 1)"
        @keydown.down="onArrow($event, -1)"
      >
    </div>
  </div>
</template>
