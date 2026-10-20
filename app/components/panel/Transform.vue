<script setup lang="ts">
/**
 * Position, size, turn and lean of the selected blocks, as numbers.
 *
 * The canvas's handles are quick and approximate; this is for when the number
 * is known — two balloons the same width, a caption square to the page, a lean
 * matched to the one beside it. It moves the same box the handles are on (the
 * framing below, which is the board's and the Lettering panel's too) and writes
 * through the same path, so a typed value and a dragged handle are one edit and
 * one undo — see `useTransform`.
 *
 * Several blocks: a field shows a value only where they agree, and a value set
 * is set on all of them.
 */
import { LinkIcon, RotateCcwIcon, SquareIcon, UnlinkIcon } from '@lucide/vue'

import type { Framing } from '~/composables/useComic'
import type { TransformField } from '~/composables/useTransform'

const { framing, selected } = useComic()
const { boxes, values, locked, distorted, transformed, set, straighten, reset } = useTransform()

const FIELDS: { field: TransformField, label: string, suffix: string, precision: number, min?: number, max?: number }[] = [
  { field: 'x', label: 'X', suffix: '', precision: 0 },
  { field: 'y', label: 'Y', suffix: '', precision: 0 },
  { field: 'w', label: 'W', suffix: '', precision: 0, min: 1 },
  { field: 'h', label: 'H', suffix: '', precision: 0, min: 1 },
]

const TURNS: { field: TransformField, label: string, title: string, min?: number, max?: number }[] = [
  { field: 'angle', label: 'Rot', title: 'Rotate, clockwise' },
  { field: 'skewX', label: 'SkX', title: 'Skew across', min: -75, max: 75 },
  { field: 'skewY', label: 'SkY', title: 'Skew down', min: -75, max: 75 },
]

/** Which box this is moving, said plainly — the translated ones follow the framing, the rest never can. */
const which = computed(() => {
  if (framing.value === 'reading') return 'The reading box — correcting it re-cuts what is cleaned under it.'

  const translated = selected.value.filter((block) => block.translation).length

  if (!translated) return 'The block itself — an untranslated block has no lettering frame to move.'

  return translated === selected.value.length
    ? 'The lettering frame. The reading and the artwork under it are left alone.'
    : 'The lettering frame where there is a translation, and the block itself where there is not.'
})
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-3">
    <p v-if="!selected.length" class="text-muted-foreground text-[11px]">
      Select a block on the page to place it by the numbers.
    </p>

    <p v-else-if="!boxes.length" class="text-muted-foreground text-[11px]">
      This page’s size is not known yet — open its picture to measure it.
    </p>

    <template v-else>
      <UToggleGroup
        type="single"
        variant="outline"
        size="sm"
        class="w-full"
        :model-value="framing"
        @update:model-value="$event && (framing = $event as Framing)"
      >
        <UToggleGroupItem value="lettering" class="flex-1" title="Move the box the translation is set in">
          Lettering
        </UToggleGroupItem>
        <UToggleGroupItem value="reading" class="flex-1" title="Move the box the lettering was found in">
          Reading
        </UToggleGroupItem>
      </UToggleGroup>

      <p class="text-muted-foreground -mt-1 text-[11px] leading-snug">
        {{ which }}
      </p>

      <UField>
        <div class="flex items-center justify-between">
          <UFieldLabel>Position &amp; size</UFieldLabel>
          <span class="text-muted-foreground/70 text-[10px]">px</span>
        </div>
        <div class="grid grid-cols-[1fr_1fr_auto] items-center gap-x-2 gap-y-1.5">
          <PanelNumberField
            v-for="one in FIELDS.slice(0, 2)"
            :key="one.field"
            :label="one.label"
            :value="values[one.field]"
            :precision="one.precision"
            @set="set(one.field, $event)"
          />
          <span />
          <PanelNumberField
            v-for="one in FIELDS.slice(2)"
            :key="one.field"
            :label="one.label"
            :value="values[one.field]"
            :precision="one.precision"
            :min="one.min"
            @set="set(one.field, $event)"
          />
          <UButton
            variant="ghost"
            size="icon-sm"
            :aria-pressed="locked"
            :aria-label="locked ? 'Width and height change together' : 'Width and height change separately'"
            :title="locked ? 'Width and height change together' : 'Width and height change separately'"
            :class="locked && 'text-primary'"
            @click="locked = !locked"
          >
            <LinkIcon v-if="locked" class="size-3.5" />
            <UnlinkIcon v-else class="size-3.5" />
          </UButton>
        </div>
      </UField>

      <UField>
        <div class="flex items-center justify-between">
          <UFieldLabel>Rotate &amp; skew</UFieldLabel>
          <span class="text-muted-foreground/70 text-[10px]">degrees</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <PanelNumberField
            v-for="one in TURNS"
            :key="one.field"
            :label="one.label"
            :title="one.title"
            :value="values[one.field]"
            :precision="1"
            :step="0.5"
            :min="one.min"
            :max="one.max"
            :resettable="values[one.field] !== 0"
            :default-value="0"
            @set="set(one.field, $event)"
          />
        </div>
      </UField>

      <!--
        Only when there is something to put back, so the row does not offer to
        undo work nobody has done.
      -->
      <div v-if="transformed" class="flex flex-wrap gap-1.5">
        <UButton v-if="distorted" variant="outline" size="sm" @click="straighten()">
          <SquareIcon class="size-3.5" />
          Straighten corners
        </UButton>
        <UButton variant="ghost" size="sm" class="text-muted-foreground" @click="reset()">
          <RotateCcwIcon class="size-3.5" />
          Reset turn &amp; skew
        </UButton>
      </div>
    </template>
  </UFieldGroup>
</template>
