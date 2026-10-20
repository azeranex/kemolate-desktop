<script setup lang="ts">
/**
 * One block, as a child of the plate it sits on in the layer stack.
 *
 * ## Why these are worked out rather than stored
 *
 * A block is not a row of the stack and must not become one. The stack is one
 * thing for the whole chapter — that is what makes dragging Cleanup above the
 * lettering hold on page forty as well as page three — and a block belongs to
 * a single page. Filing blocks into it would either strand page three's boxes
 * in page four's panel, or force a stack per page and take the chapter-wide
 * ordering away.
 *
 * So the panel derives them: `PanelLayerRow` asks the open page for the blocks
 * on its plate and draws one of these apiece. Nothing here is state. The eye
 * writes `block.hidden` and the row reads the same selection the canvas does,
 * which is also why this list and the Blocks panel cannot disagree — there is
 * one block, and both are looking straight at it.
 */
import { EyeIcon, EyeOffIcon } from '@lucide/vue'

const props = defineProps<{ block: Block, index: number, depth: number }>()

/**
 * How far the row is set in — one step per level, the same as every other row
 * in the tree.
 *
 * It was pushed a further column right for a while, so that its number began
 * where a plain plate's name begins and the two looked equally nested. The
 * guide line their parent now draws says that outright, so the block can sit
 * on the ordinary grid: number in the marker column, name beside it, both in
 * the columns the Mask and Cleaned plate rows use.
 */
const indent = computed(() => props.depth * TREE_STEP)

const { selection, select, blockPickable, update } = useComic()

/**
 * What the row reads: the line as it will be lettered, the original until
 * there is one, and the block's number for a box with nothing in it at all —
 * which is a real state, and a blank row would read as a fault rather than as
 * work still to do.
 */
const text = computed(() => props.block.translation || props.block.source || `Block ${props.index + 1}`)

const untranslated = computed(() => !props.block.translation)
</script>

<template>
  <!--
    `min-w-0` on the row for the reason the block list carries it — see
    `Blocks.vue`. This one shows the same readings that list does, so it is the
    same long line in the same kind of grid, one twirl further in.
  -->
  <div
    class="hover:bg-accent group/block relative flex min-w-0 cursor-default items-center gap-1.5 rounded-sm py-1 pr-2 text-sm"
    :class="[
      selection.includes(block.id) && 'bg-accent',
      !blockPickable(block) && 'opacity-40',
      !block.hidden || 'opacity-50',
    ]"
    :title="blockPickable(block) ? undefined : 'On a layer that is hidden or locked'"
    @click="select(block.id, { add: addsToSelection($event), range: $event.shiftKey })"
  >
    <!--
      The eye keeps the column every other row's eye is in, however deep the
      block sits — the same rule the layer rows follow, and for the same
      reason: a sweep down the column has to be able to find them.
    -->
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground ml-1 flex-none"
      :aria-label="`${block.hidden ? 'Show' : 'Hide'} block ${index + 1}`"
      :aria-pressed="!block.hidden"
      @click.stop="update(block.id, { hidden: !block.hidden })"
    >
      <EyeIcon v-if="!block.hidden" class="size-4" />
      <EyeOffIcon v-else class="size-4" />
    </button>

    <!--
      The number leads the row, in a slot the width of the one a layer row
      keeps for its twirl — so a run of blocks is a tidy column of numbers
      whatever they are called, and two digits do not shove the names apart.
    -->
    <span
      class="flex size-4 flex-none items-center justify-center font-mono text-[10px] tabular-nums"
      :class="BLOCK_TONE[block.type]"
      :style="{ marginLeft: `${indent}px` }"
    >
      {{ index + 1 }}
    </span>

    <span
      class="min-w-0 flex-1 truncate"
      :class="untranslated && [STANDING_IN_TONE, 'italic']"
      :title="block.source"
    >
      {{ text }}
    </span>
  </div>
</template>
