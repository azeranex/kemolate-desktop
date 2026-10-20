<script setup lang="ts">
import {
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignEndHorizontalIcon,
  AlignEndVerticalIcon,
  AlignHorizontalDistributeCenterIcon,
  AlignHorizontalDistributeEndIcon,
  AlignHorizontalDistributeStartIcon,
  AlignStartHorizontalIcon,
  AlignStartVerticalIcon,
  AlignVerticalDistributeCenterIcon,
  AlignVerticalDistributeEndIcon,
  AlignVerticalDistributeStartIcon,
} from '@lucide/vue'

/**
 * Where the selection sits in its box, and how several of them are spaced
 * against each other. Both rows read the same way: the horizontal axis in the
 * first group, the vertical in the second, each start · centre · end.
 *
 * The arithmetic is not here — see `useAlign`, which is where the note about
 * measuring in the scan's own pixels lives. This panel is the buttons, what
 * they are lined up against, and the one line telling a reader how to name the
 * block they are lined up *on*.
 */
const { page, selected, keyBlock } = useComic()
const { alignTo, alignable, distributable, measured, align, distribute } = useAlign()

/**
 * The key by the number the page calls it — the same number the badge above its
 * north-west corner shows, so "block 4" in this sentence and the 4 on the page
 * are the same claim. Naming it by its text would be a second name for the
 * same thing, and an empty one for every balloon nobody has translated yet.
 */
const keyNumber = computed(() => {
  const found = page.value?.blocks.findIndex((block) => block.id === keyBlock.value?.id) ?? -1

  return found === -1 ? null : found + 1
})

/**
 * One line saying what the buttons will do, or what is missing before they can.
 *
 * It is here because the key object is the one thing on this panel that cannot
 * be reached from it: naming one is a click on the page, and a control that
 * says "Key object" while offering no way to get one is a control that reads as
 * broken. This is where somebody looking for align will be, so this is where
 * the gesture is written down.
 */
const hint = computed(() => {
  if (!measured.value) return 'Waiting on the page — nothing has measured the scan yet.'
  if (!selected.value.length) return 'Nothing picked. Pick blocks on the page or in the list.'
  if (keyNumber.value) return `Lining up on block ${keyNumber.value}. Click it again to release it.`
  if (selected.value.length > 1) return 'Click one of the picked blocks again to line the rest up on it.'

  return 'One block picked — align it to the page, or pick another to line them up together.'
})
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-3">
    <!--
      Wraps like the distribute row below it, and for the same reason: three
      fixed-width groups side by side are wider than a column the dock has
      squeezed, and without this the select on the end left the panel.
    -->
    <div class="flex flex-wrap gap-1.5">
      <div class="grid gap-1.5">
        <UFieldLabel>Align Objects</UFieldLabel>
        <div class="flex flex-wrap gap-2">
          <UButtonGroup>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align left"
              :disabled="!alignable"
              @click="align('x', 'start')"
            >
              <AlignStartVerticalIcon />
            </UButton>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align centre"
              :disabled="!alignable"
              @click="align('x', 'centre')"
            >
              <AlignCenterVerticalIcon />
            </UButton>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align right"
              :disabled="!alignable"
              @click="align('x', 'end')"
            >
              <AlignEndVerticalIcon />
            </UButton>
          </UButtonGroup>
        </div>
      </div>
      <div class="grid gap-1.5">
        <UFieldLabel>&nbsp;</UFieldLabel>
        <div class="flex flex-wrap gap-2">
          <UButtonGroup>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align top"
              :disabled="!alignable"
              @click="align('y', 'start')"
            >
              <AlignStartHorizontalIcon />
            </UButton>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align middle"
              :disabled="!alignable"
              @click="align('y', 'centre')"
            >
              <AlignCenterHorizontalIcon />
            </UButton>
            <UButton
              variant="outline"
              size="icon-sm"
              aria-label="Align bottom"
              :disabled="!alignable"
              @click="align('y', 'end')"
            >
              <AlignEndHorizontalIcon />
            </UButton>
          </UButtonGroup>
        </div>
      </div>
      <div class="grid gap-1.5">
        <UFieldLabel>Align To</UFieldLabel>
        <!--
          Three choices, one of which cannot be picked here: a key object is a
          block, and the only place to say which block is the page. It is in the
          list so that a selection with one named says what it is aligning to in
          the same place the other two are read, rather than leaving the row
          saying "Selection" while the page does something else.
        -->
        <USelect :model-value="alignTo" @update:model-value="alignTo = String($event) as typeof alignTo">
          <USelectTrigger class="w-24" size="sm">
            <USelectValue placeholder="Align to" />
          </USelectTrigger>
          <USelectContent>
            <USelectGroup>
              <USelectLabel>Align to</USelectLabel>
              <USelectItem value="selection">
                Selection
              </USelectItem>
              <USelectItem value="key" :disabled="!keyBlock">
                Key object
              </USelectItem>
              <USelectItem value="page">
                Page
              </USelectItem>
            </USelectGroup>
          </USelectContent>
        </USelect>
      </div>
    </div>

    <!--
      Distribute needs three or more selected to mean anything: it spaces
      them evenly, measuring from the named edge of each.
    -->
    <div class="grid gap-1.5">
      <UFieldLabel>Distribute Objects</UFieldLabel>
      <div class="flex flex-wrap gap-2">
        <UButtonGroup>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute horizontally by left edges"
            :disabled="!distributable"
            @click="distribute('x', 'start')"
          >
            <AlignHorizontalDistributeStartIcon />
          </UButton>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute horizontally by centres"
            :disabled="!distributable"
            @click="distribute('x', 'centre')"
          >
            <AlignHorizontalDistributeCenterIcon />
          </UButton>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute horizontally by right edges"
            :disabled="!distributable"
            @click="distribute('x', 'end')"
          >
            <AlignHorizontalDistributeEndIcon />
          </UButton>
        </UButtonGroup>
        <UButtonGroup>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute vertically by top edges"
            :disabled="!distributable"
            @click="distribute('y', 'start')"
          >
            <AlignVerticalDistributeStartIcon />
          </UButton>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute vertically by centres"
            :disabled="!distributable"
            @click="distribute('y', 'centre')"
          >
            <AlignVerticalDistributeCenterIcon />
          </UButton>
          <UButton
            variant="outline"
            size="icon-sm"
            aria-label="Distribute vertically by bottom edges"
            :disabled="!distributable"
            @click="distribute('y', 'end')"
          >
            <AlignVerticalDistributeEndIcon />
          </UButton>
        </UButtonGroup>
      </div>
    </div>

    <p class="text-muted-foreground text-[11px]">
      {{ hint }}
    </p>
  </UFieldGroup>
</template>
