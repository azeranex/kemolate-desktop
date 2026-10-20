<script setup lang="ts">
/**
 * One row of the Blocks panel: a block, in reading order.
 *
 * A component of its own for the reason `PanelBlockRow` is one, and a measured
 * one. Written inline in the panel, every row was part of the panel's render,
 * so a keystroke into any balloon, a click on any block or an eye toggled on
 * one row drew every row again — each with a type menu of its own, a Reka tree
 * a dozen components deep whose slots named the row's block and so had to be
 * rendered again with it. On the test chapter's page of eight blocks, picking
 * a different block rendered 240 components, most of them those menus, and a
 * selection handed back unchanged still rendered 181; they are 79 and 14 now.
 * A row renders when something it shows changes: its block, or one of the
 * flags below.
 *
 * Nothing here is state and nothing here edits. The panel decides what each
 * press means and holds the one type menu every row opens — see `Blocks.vue` —
 * so a row says which block and what was asked. And the flags are worked out
 * there rather than read here: a row that asked the selection itself would
 * render again on every change of it, which is the render this exists to
 * spare.
 */
import { CircleAlertIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'

const props = defineProps<{
  block: Block
  index: number
  /** In the selection. */
  selected: boolean
  /** On a layer the tools can reach — see `blockPickable`. */
  pickable: boolean
  /** Being dragged to another place in the reading order. */
  dragging: boolean
  /** Which edge the insertion line is drawn on, while a drop would land against this row. */
  edge: 'top' | 'bottom' | null
  /** Whether the page has a scan to read the balloon from again. */
  scanned: boolean
  /** Whether a reading is running, which the re-read waits for. */
  reading: boolean
  /** Whether the type menu is open on this row. */
  typing: boolean
}>()

/**
 * What was asked of the row, by block id — so the panel can answer every row
 * with the same handler rather than one made per row per render, which would
 * be a new prop on every row every time and undo the whole point.
 */
const emit = defineEmits<{
  pick: [id: string, event: MouseEvent]
  hide: [id: string]
  type: [id: string, anchor: HTMLElement]
  reread: [id: string]
  remove: [id: string]
  dragstart: [id: string, event: DragEvent]
  dragover: [index: number, event: DragEvent]
  drop: []
  dragend: []
}>()

/**
 * What a row reads, and whether it is standing in for something missing.
 *
 * The translation where there is one, the source where there is not — one line
 * either way, because a row is for *finding* a block rather than reading it,
 * and two would halve how many fit and turn the list into the panel below it.
 *
 * There was a toggle above the list that switched every row between the two,
 * and it is gone. This falls back on its own, so the only state it could reach
 * that this does not is "show me the original even though a translation
 * exists" — which is one block at a time, is what the Text panel shows anyway,
 * and is on the row's own tooltip.
 */
const text = computed(() => props.block.translation || props.block.source)

const standingIn = computed(() => !props.block.translation)

const { fitOf } = useLetteringFit()

/**
 * Whether this line does not fit its balloon even squeezed — see `LetterFit.over`.
 * Marked in the list because it is the one thing on a page a letterer has to
 * go and do something about, and a page of forty lines is not read balloon by
 * balloon to find it.
 */
const overflows = computed(() => Boolean(props.block.translation.trim() && fitOf(props.block)?.over))
</script>

<template>
  <!--
    `min-w-0` on the row itself — see the list in `Blocks.vue`, which says why
    it is not the same `min-w-0` as the one on the reading inside it.
  -->
  <div
    draggable="true"
    class="group/row hover:bg-accent relative flex min-w-0 cursor-grab items-center gap-1.5 rounded-sm py-1 pr-2 text-sm active:cursor-grabbing"
    :class="[
      selected && 'bg-accent',
      dragging && 'opacity-40',
      // The row stays and stays readable — a block is still a block when its
      // layer is off — but it says it is not one you can pick right now. The
      // refusal itself is `select`'s; this is only the row admitting to it.
      !pickable && 'opacity-40',
    ]"
    :title="pickable ? undefined : 'On a layer that is hidden or locked'"
    @click="emit('pick', block.id, $event)"
    @dragstart="emit('dragstart', block.id, $event)"
    @dragover="emit('dragover', index, $event)"
    @drop="emit('drop')"
    @dragend="emit('dragend')"
  >
    <!--
      Drawn over the row rather than between the rows: a line that took up
      height of its own would shove everything below it down by two pixels each
      time the drop moved, under a pointer trying to aim at it.
    -->
    <div
      v-if="edge"
      class="bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full"
      :class="edge === 'top' ? 'top-0' : 'bottom-0'"
    />
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground ml-1 flex-none"
      :aria-label="block.hidden ? 'Show block' : 'Hide block'"
      @click.stop="emit('hide', block.id)"
    >
      <EyeOffIcon v-if="block.hidden" class="size-4" />
      <EyeIcon v-else class="size-4" />
    </button>

    <span
      class="flex size-4 flex-none items-center justify-center font-mono text-[10px] tabular-nums"
      :class="BLOCK_TONE[block.type]"
    >
      {{ index + 1 }}
    </span>

    <!--
      The translation, falling back to the source where there is not one yet
      and greyed to say so — a row that went blank would look like a block with
      nothing in it rather than one with nothing done to it. Whichever is not
      showing is on the tooltip.
    -->
    <div
      class="min-w-0 flex-1 truncate"
      :class="standingIn && [STANDING_IN_TONE, 'italic']"
      :title="block.translation ? block.source : ''"
    >
      {{ text }}
    </div>

    <span
      v-if="overflows"
      class="text-destructive flex-none"
      title="Does not fit its balloon — see Lettering › Shorten to fit"
      aria-label="Does not fit its balloon"
    >
      <CircleAlertIcon class="size-3.5" />
    </span>

    <!--
      The block's type, and the way to change it: the panel's one type menu,
      opened against this button. Held to the height of the line beside it, so
      the row comes out the same height as a layer row. Left to itself the
      button was four pixels taller than the text and set the whole row's
      height, and the two panels listed the same blocks at two different
      rhythms.
    -->
    <UButton
      :variant="block.type !== 'garbage' ? 'secondary' : 'destructive'"
      size="xs"
      class="h-5 flex-none px-1.5"
      aria-haspopup="menu"
      :aria-expanded="typing"
      @click.stop="emit('type', block.id, $event.currentTarget as HTMLElement)"
    >
      {{ block.type }}
    </UButton>

    <!--
      Reads this balloon again, without having to select it first — see
      `reread` in the panel. Invisible rather than greyed on a block with no
      source: that is lettering somebody placed with the Text tool, there is no
      printed line to read *again*, and re-reading would write one onto it.
      `invisible` rather than `v-if` so the bin after it stays in the same place
      on every row. Disabled, not hidden, while a read runs: that is "not right
      now", which a greyed control says honestly.
    -->
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground flex-none focus-visible:opacity-100 disabled:opacity-40"
      :class="block.source && scanned ? 'opacity-0 group-hover/row:opacity-100' : 'invisible'"
      :disabled="reading"
      :aria-label="`Re-read block ${index + 1}`"
      @click.stop="emit('reread', block.id)"
    >
      <RefreshCwIcon class="size-3.5" />
    </button>

    <!--
      Shown on hover like the lock in the layer panel: a column of bins down an
      untouched list is an invitation to press one, and this is the only
      control here that cannot be shrugged off. Undo takes it back — see
      `removeBlock` — so it asks nothing first.
    -->
    <button
      type="button"
      class="text-muted-foreground hover:text-destructive flex-none opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      :aria-label="`Delete block ${index + 1}`"
      @click.stop="emit('remove', block.id)"
    >
      <Trash2Icon class="size-3.5" />
    </button>
  </div>
</template>
