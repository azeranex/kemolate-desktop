<script setup lang="ts">
/**
 * The stack the page is built out of, top to bottom, in groups.
 *
 * Each row does something: hiding the cleaned plate shows the printed lettering
 * it painted over, and dragging one past another changes the order the canvas
 * composites in. A group is not a thing on the page but a thing said about the
 * things under it — hide "Lettering" and both its plates go with it, half-fade
 * it and both are halved, lock it and neither is open to a tool — which is what
 * makes it a stack rather than a list. A layer panel whose switches changed
 * nothing would be worth less than no layer panel at all.
 *
 * What any of that adds up to on the page is `shared/utils/layers`, not here:
 * this file lists the stack and the canvas paints it, and both ask the same
 * derivation so that neither can be the one that is wrong.
 *
 * Opacity is set for whichever row is selected rather than on every row: a
 * slider apiece would be one per plate plus one per group, and the number on
 * each row already says where it stands.
 *
 * The scan is locked and stays locked. Everything else is laid on top of it,
 * and the one thing that must not be edited is the page as it arrived.
 *
 * ## The stack belongs to the page; the stages speak for the chapter
 *
 * Every row here is this page's — see `layers.pageId`. That replaced one stack
 * for the whole chapter, which could not be told to leave a page alone: a sheet
 * added to sketch over one panel appeared on all three hundred.
 *
 * The presets are the deliberate exception. A stage of work is a fact about the
 * chapter rather than the page — you clean the chapter, then letter it — so
 * pressing one arranges the standard plates the same way everywhere. It is safe
 * to let those reach every page precisely because of how little they do: three
 * fields, on the seven rows every page is founded with, never an insert or a
 * delete. Sheets, groups and adjustments somebody added are page-owned things
 * and no stage has an opinion about them.
 */
import { FolderPlusIcon, ImagePlusIcon, SlidersHorizontalIcon, SquarePlusIcon, Trash2Icon } from '@lucide/vue'

const {
  layers, layerSelection, setLayer, addAdjustLayer, addGroupLayer, addPaintLayer, addImageLayer,
  removable, removeLayer, endEyeDrag,
} = useComic()

const { place } = usePlacedImages()

/** While the file is read, decoded and hashed — a beat, on a full-size clean. */
const placing = ref(false)

/**
 * Pick a picture and put it on the page.
 *
 * The row is only made once the bytes are safely filed, which is the order that
 * matters: a row naming an image nothing holds would draw as a gap in the stack
 * that no amount of pressing could fill.
 */
async function placeImage () {
  if (placing.value) return

  const file = await pickImage()

  // The dialog was closed. Not a failure and not worth a word.
  if (!file) return

  placing.value = true

  const done = await place(file).finally(() => { placing.value = false })

  // Each refusal names what was wrong with the file rather than saying it did
  // not work — see `place`, where both of them are written.
  if ('refused' in done) toast.error(done.refused)
  else addImageLayer(done.image)
}

const { presets, active, apply, writable: staged } = useLayerPresets()

/** The selected row, wherever in the tree it is. */
const current = computed(() => (layerSelection.value ? findLayer(layers.value, layerSelection.value) : null))

/**
 * The opacity slider means two things, and says which.
 *
 * On a plate it is how far through you see it. On an adjustment — a row that
 * draws nothing — there is nothing to see through, so the same number is how
 * hard the adjustment is applied: half is halfway between the original and
 * the full curve. One slider rather than two, because it is the same idea
 * either way — how much of this row is there — and a second control for it
 * would be a second thing to find.
 */
const strength = computed(() => Boolean(current.value?.adjust))

/*
 * A sweep across the eyes ends wherever the pointer is let go — which is very
 * often not over a row, and sometimes not over the panel at all. The window is
 * the only listener that hears all of those, and this panel is the one place to
 * hang it: the rows are drawn by a component that draws itself again for its
 * children, so one listener per row would be one per row of the tree.
 */
if (import.meta.client) {
  useEventListener(window, 'pointerup', endEyeDrag)
  useEventListener(window, 'pointercancel', endEyeDrag)
}
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-2">
    <div class="flex items-center gap-1">
      <UFieldLabel class="w-12 flex-none">
        {{ strength ? 'Amount' : 'Opacity' }}
      </UFieldLabel>
      <USlider
        :model-value="[current?.opacity ?? 100]"
        :min="0"
        :max="100"
        :step="5"
        :disabled="!current"
        aria-label="Layer opacity"
        class="mx-1 flex-1"
        @update:model-value="current && setLayer(current.id, { opacity: ($event as number[])[0] ?? current.opacity })"
      />
      <span class="text-muted-foreground w-8 flex-none text-right font-mono text-xs tabular-nums">
        {{ current?.opacity ?? 100 }}%
      </span>

      <!--
        What can be added and what can be taken away, on the line the slider is
        already on: all four controls act on the stack below, and none of them
        needs a row of its own to say so.

        The plates are what the page *is* and there is no button here that makes
        a new one. What a reader may make is a sheet of their own to paint on,
        something done *to* the page, and a way to arrange either — and each
        lands above whatever is selected, so choosing where it goes is the
        ordinary business of picking a row first.
      -->
      <UTooltip>
        <UTooltipTrigger as-child>
          <UButton variant="ghost" size="icon-sm" aria-label="New layer" @click="addPaintLayer()">
            <SquarePlusIcon class="size-4" />
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent>New layer — a blank sheet to paint on</UTooltipContent>
      </UTooltip>

      <!--
        And a picture, which is the one thing a reader adds that arrives with
        its pixels already decided.

        Beside the blank sheet rather than in a menu of its own: they are the
        same gesture — put something of mine on this page — and differ only in
        whether it starts empty. The clean raw is what it is for and the stack
        has no opinion about that; see `addImageLayer` for where one lands and
        why it is the bottom of the cleanup group.
      -->
      <UTooltip>
        <UTooltipTrigger as-child>
          <UButton
            variant="ghost"
            size="icon-sm"
            aria-label="Place an image"
            :disabled="placing"
            @click="placeImage()"
          >
            <ImagePlusIcon class="size-4" />
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent>Place an image — a clean page, a redraw, anything of yours</UTooltipContent>
      </UTooltip>

      <UDropdownMenu>
        <UDropdownMenuTrigger as-child>
          <UButton variant="ghost" size="icon-sm" aria-label="New adjustment">
            <SlidersHorizontalIcon class="size-4" />
          </UButton>
        </UDropdownMenuTrigger>
        <UDropdownMenuContent align="end">
          <UDropdownMenuLabel>New adjustment</UDropdownMenuLabel>
          <UDropdownMenuItem v-for="kind in ADJUSTMENTS" :key="kind.type" @click="addAdjustLayer(kind.type)">
            {{ kind.label }}
          </UDropdownMenuItem>
        </UDropdownMenuContent>
      </UDropdownMenu>

      <UTooltip>
        <UTooltipTrigger as-child>
          <UButton variant="ghost" size="icon-sm" aria-label="New group" @click="addGroupLayer()">
            <FolderPlusIcon class="size-4" />
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent>New group — drag rows into it</UTooltipContent>
      </UTooltip>

      <!--
        Disabled rather than absent for a row that may not go, so that "this one
        cannot be deleted" is something the panel says rather than something you
        find out by pressing. What may go is `layerRemovable`'s answer: the
        plates the page is made of, and anything holding one, stay.
      -->
      <UTooltip>
        <UTooltipTrigger as-child>
          <UButton
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-destructive"
            :disabled="!removable"
            aria-label="Delete layer"
            @click="layerSelection && removeLayer(layerSelection)"
          >
            <Trash2Icon class="size-4" />
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent>
          {{ removable ? `Delete ${current?.label}` : 'The page’s own plates cannot be deleted' }}
        </UTooltipContent>
      </UTooltip>
    </div>

    <USeparator />

    <!--
      What you are about to do, as four buttons.

      Above the stack rather than below it, because choosing a stage is what you
      do *before* looking at the rows — and because what it changes is the rows
      themselves, which then read as the answer.

      One row of equal buttons, so no stage looks like the default. There is no
      "none" among them: the lit one goes out the moment anything is arranged by
      hand, which is `useLayerPresets.active` saying that the stack stopped
      being the stage's and became the reader's.
    -->
    <div class="grid gap-1">
      <UFieldLabel>Working on</UFieldLabel>
      <div class="grid grid-cols-4 gap-1">
        <UTooltip v-for="preset in presets" :key="preset.id">
          <UTooltipTrigger as-child>
            <UButton
              :variant="active === preset.id ? 'secondary' : 'ghost'"
              size="sm"
              :disabled="!staged"
              :aria-pressed="active === preset.id"
              class="h-7 text-xs"
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
    </div>

    <div class="grid gap-0.5">
      <PanelLayerRow v-for="layer in layers" :key="layer.id" :layer="layer" :depth="0" />
    </div>

    <!--
      And its controls, when the selected row is one. Under the stack rather
      than in a panel of its own: these are the numbers of the row highlighted
      a few pixels above, and anywhere else would have to name it.
    -->
    <template v-if="current?.adjust">
      <USeparator />
      <PanelAdjust :layer="current" />
    </template>
  </UFieldGroup>
</template>
