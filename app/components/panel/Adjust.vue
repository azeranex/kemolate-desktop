<script setup lang="ts">
/**
 * The controls for whichever adjustment row is selected.
 *
 * Shown in the Layers panel under the stack rather than in a panel of its own,
 * because an adjustment is a row you picked and these are that row's numbers —
 * putting them anywhere else would mean saying *which* adjustment they belong
 * to, which the highlighted row already says.
 *
 * Every control writes straight through `setLayer`, so the canvas redraws from
 * the same state the panel is reading. There is no apply and no preview: the
 * page under the slider *is* the preview, and an adjustment that had to be
 * committed would be one you could forget to commit.
 */
import { CornerLeftDownIcon } from '@lucide/vue'

const props = defineProps<{ layer: StackLayer }>()

const { setLayer, setLayerClipped, clipTarget } = useComic()

/**
 * What this adjustment is clipped to, said in words.
 *
 * The row already draws the arrow; this is the sentence that says what the
 * arrow means, because "clipped" is a Photoshop word and the thing it names —
 * "this reaches one layer instead of everything below" — is not obvious from
 * an icon to anybody who has not met it before.
 */
const clip = computed(() => (props.layer.clipped ? clipTarget(props.layer.id) : null))

/** The row's numbers, narrowed — this only ever draws for a row that has them. */
const adjust = computed(() => props.layer.adjust)

const route = useRoute()

const workspace = computed(() => String(route.params.workspaceId ?? ''))

/**
 * One field of the adjustment written back, leaving the rest as it was.
 *
 * And said out loud as it moves. Every control comes through here, so this is
 * the one place a drag can be watched from — and a drag is exactly the case the
 * durable path serves badly: `useLayerSync` settles for six hundred
 * milliseconds before writing, which is right for a stack nobody is watching
 * and far too slow to look like somebody else's hand on the slider.
 *
 * So the value goes twice, by two roads with two jobs. This one is a frame,
 * relayed and forgotten; the settle that follows is the record. Letting go
 * changes nothing about either — there is no separate commit, because the
 * ordinary write was always going to happen and the last thing sent live is by
 * definition the value it will carry.
 */
function set (patch: Partial<Adjustment>) {
  if (!adjust.value) return

  const next = { ...adjust.value, ...patch } as Adjustment

  setLayer(props.layer.id, { adjust: next })

  sendLive(workspace.value, { kind: 'adjust', uid: props.layer.id, adjust: next })
}

/** Back to the identity, without losing the row or where it sits in the stack. */
function reset () {
  if (adjust.value) setLayer(props.layer.id, { adjust: newAdjustment(adjust.value.type) })
}

/**
 * The sliders, per kind. Written out here rather than in the template so that
 * each is one row of numbers — what it is called, what it reads, the range it
 * moves through — and the template is one loop.
 *
 * Gamma is the one that is not a level: it is a bend, and it moves on tenths
 * between a tenth and three, which is the range every other editor offers
 * because outside it the midtones are already at one end or the other.
 */
const dials = computed(() => {
  const a = adjust.value

  if (!a) return []

  if (a.type === 'tone') {
    return [
      { key: 'brightness' as const, label: 'Brightness', value: a.brightness, min: -100, max: 100, step: 1 },
      { key: 'contrast' as const, label: 'Contrast', value: a.contrast, min: -100, max: 100, step: 1 },
    ]
  }

  return [
    { key: 'inBlack' as const, label: 'Input black', value: a.inBlack, min: 0, max: 255, step: 1 },
    { key: 'inWhite' as const, label: 'Input white', value: a.inWhite, min: 0, max: 255, step: 1 },
    { key: 'gamma' as const, label: 'Gamma', value: a.gamma, min: 0.1, max: 3, step: 0.05 },
    { key: 'outBlack' as const, label: 'Output black', value: a.outBlack, min: 0, max: 255, step: 1 },
    { key: 'outWhite' as const, label: 'Output white', value: a.outWhite, min: 0, max: 255, step: 1 },
  ]
})

/**
 * The curve as a line, for the little graph above the sliders.
 *
 * Drawn from the very table the page is being filtered through — see
 * `adjustLut` — rather than from a second reading of the numbers, so what the
 * graph says and what the pixels do cannot come apart. Sampled every fourth
 * level, which is more than enough for sixty-four pixels of graph.
 */
const curve = computed(() => {
  const a = adjust.value

  if (!a) return ''

  const lut = adjustLut(a, (props.layer.opacity ?? 100) / 100)
  const points: string[] = []

  for (let i = 0; i <= 255; i += 4) points.push(`${(i / 255) * 64},${64 - (lut[i] ?? 0) * 64}`)

  return points.join(' ')
})
</script>

<template>
  <UFieldGroup v-if="adjust" density="panel" class="grid gap-2">
    <div class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ layer.label }}</span>
      <UButton
        :variant="layer.clipped ? 'secondary' : 'ghost'"
        size="sm"
        class="h-6 px-1.5 text-[11px]"
        :aria-pressed="!!layer.clipped"
        @click="setLayerClipped(layer.id, !layer.clipped)"
      >
        <CornerLeftDownIcon class="size-3" />
        Clip
      </UButton>
      <!--
        Delete is not here as well. It is in the stack's own toolbar, acting on
        the selected row — which is this row, since these are its controls — and
        two buttons for one act, a hundred pixels apart, is one more than the
        panel needs.
      -->
      <UButton variant="ghost" size="sm" class="h-6 px-1.5 text-[11px]" @click="reset()">
        Reset
      </UButton>
    </div>

    <!--
      What the arrow on the row means, in words. "Clipped" is a Photoshop word,
      and the thing it names — this reaches one layer instead of everything
      under it — is not something an icon can say to somebody meeting it for
      the first time.
    -->
    <p class="text-[11px]" :class="layer.clipped && !clip ? 'text-destructive' : 'text-muted-foreground'">
      <template v-if="clip">Adjusting <span class="text-foreground">{{ clip.label }}</span> only.</template>
      <template v-else-if="layer.clipped">Clipped to nothing — there is no layer below it.</template>
      <template v-else>Adjusting everything below it.</template>
    </p>

    <!--
      The curve, so that what the numbers add up to can be seen at a glance —
      a straight diagonal is "does nothing", which is the state an adjustment
      is added in and the state Reset puts it back to.
    -->
    <svg viewBox="0 0 64 64" class="bg-muted/40 h-24 w-full rounded-sm" preserveAspectRatio="none">
      <line x1="0" y1="64" x2="64" y2="0" class="stroke-muted-foreground/30" stroke-width="0.5" />
      <polyline :points="curve" fill="none" class="stroke-primary" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>

    <div v-for="dial in dials" :key="dial.key" class="flex items-center gap-2">
      <UFieldLabel class="w-20 flex-none truncate">{{ dial.label }}</UFieldLabel>
      <USlider
        :model-value="[dial.value]"
        :min="dial.min"
        :max="dial.max"
        :step="dial.step"
        :aria-label="dial.label"
        class="flex-1"
        @update:model-value="set({ [dial.key]: ($event as number[])[0] ?? dial.value } as Partial<Adjustment>)"
      />
      <span class="text-muted-foreground w-9 flex-none text-right font-mono text-xs tabular-nums">
        {{ dial.step < 1 ? dial.value.toFixed(2) : dial.value }}
      </span>
    </div>
  </UFieldGroup>
</template>
