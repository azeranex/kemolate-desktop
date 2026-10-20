<script setup lang="ts">
/**
 * One page of the Pages strip: its thumbnail, its name and its count.
 *
 * A component of its own, measured. Written inline in the strip, every tile was
 * part of the strip's render, and the strip read the page being worked on and
 * every page's block count — so a page turn drew every tile again, and so did a
 * reading landing on any page, once per page of a whole-chapter read. The
 * delete button made it worse: its handler named its tile's page, so the
 * compiler could not keep it and every tile's button was handed a new one, and
 * drawn again with its primitives, on every render. On the test chapter's eight
 * pages the open strip added 37 renders to a page turn, a button and its
 * primitive per tile among them; it adds 23 now, and none of them per tile but
 * the two whose ring moved.
 *
 * Now a tile reads its own page, and the strip hands it flags it worked out
 * once — `current` above all, which changes on two tiles when the page turns
 * rather than being asked by all of them. The tile says which page and what was
 * asked, and the strip decides what that means.
 */
import { LinkIcon, Trash2Icon } from '@lucide/vue'

const props = defineProps<{
  page: ComicPage
  index: number
  /** The page being worked on. */
  current: boolean
  /** Being dragged to another place in the reading order. */
  dragging: boolean
  /** Which side the insertion bar is drawn on, while a drop would land against this tile. */
  edge: 'left' | 'right' | null
  /** A file is being held over this absent page. */
  dropping: boolean
  /** The name is being edited. */
  renaming: boolean
}>()

const emit = defineEmits<{
  go: [index: number]
  remove: [page: ComicPage]
  locate: [page: ComicPage]
  dragstart: [id: string, event: DragEvent]
  over: [page: ComicPage, index: number, event: DragEvent]
  leave: [id: string]
  drop: [page: ComicPage, event: DragEvent]
  dragend: []
  rename: [page: ComicPage]
  commit: [id: string, name: string]
  cancel: []
}>()

/**
 * The name as it is being typed — the tile's while the field is open, and
 * started from the page's name each time it opens.
 */
const draft = ref('')

watch(() => props.renaming, (on) => { if (on) draft.value = props.page.name }, { immediate: true })

/**
 * A named function rather than an inline one, on purpose: an inline ref is a
 * new function every render, which Vue calls again on every keystroke — and a
 * field that re-selects its contents as you type eats what you typed.
 */
function focusName (el: unknown) {
  if (!(el instanceof HTMLInputElement)) return

  // After the patch that mounted it, not during: the v-model write that
  // follows would put the caret at the end and quietly undo the select.
  nextTick(() => {
    el.focus()
    el.select()
  })
}
</script>

<template>
  <div class="group relative">
    <!--
      Delete is a *sibling* of the draggable cell, not a child of it, and that is
      the whole of why it now works.

      A button inside a `draggable` element is not a button the pointer can
      reach: the press lands on the cell's drag gesture, the browser starts
      dragging the thumbnail, and the click is never delivered. It looked fine in
      every test because a scripted `.click()` dispatches the event directly and
      never involves dragging at all — the one way of pressing it that could not
      reproduce what everybody else was doing.

      `index.vue` already had this written down for the workspace menu, in those
      words, about an anchor. Same shape, one component along.

      Shown on hover and on focus rather than always: a delete on every tile of a
      forty-page strip is forty invitations to lose work. It sits over the corner
      of the art rather than beside the name, where the rename field already is
      and a stray click would land on it.
    -->
    <UButton
      variant="destructive"
      size="icon-sm"
      class="absolute top-1 right-1 z-30 size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      :aria-label="`Remove ${page.name}`"
      @click.stop="emit('remove', page)"
    >
      <Trash2Icon class="size-3.5" />
    </UButton>

    <!--
      Its file, for a page that has none. Beside the delete for the reason that
      one is a sibling of the draggable cell rather than a child: a button inside
      a `draggable` element never receives the click, because the press starts a
      drag instead. Always visible rather than on hover, unlike the delete — this
      is the one useful thing to do to an absent page, and hiding the only way
      forward behind a hover is how a state becomes a dead end.
    -->
    <UButton
      v-if="isOffline(page)"
      variant="secondary"
      size="icon-sm"
      class="absolute top-1 left-1 z-30 size-6"
      :aria-label="`Find the file for ${page.name}`"
      title="Find this page's file"
      @click.stop="emit('locate', page)"
    >
      <LinkIcon class="size-3.5" />
    </UButton>

    <div
      :draggable="!renaming"
      class="grid cursor-pointer gap-1 rounded-sm text-left"
      :class="dragging && 'opacity-40'"
      :aria-current="current"
      @click="emit('go', index)"
      @dragstart="emit('dragstart', page.id, $event)"
      @dragover="emit('over', page, index, $event)"
      @dragleave="emit('leave', page.id)"
      @drop="emit('drop', page, $event)"
      @dragend="emit('dragend')"
    >
      <!--
        The insertion bar stands in the gap between cells rather than on one, so
        it never sits over a thumbnail or the ring inside it.
      -->
      <div
        v-if="edge"
        class="bg-primary pointer-events-none absolute inset-y-0 z-10 w-0.5 rounded-full"
        :class="edge === 'left' ? '-left-[5px]' : '-right-[5px]'"
      />

      <!--
        `content-visibility: auto`, so a tile scrolled out of the strip is not
        laid out or painted, and its thumbnail not decoded, until it comes
        near. On the thumbnail's box rather than the tile: it implies paint
        containment, which would clip the insertion bar standing in the gap
        beside the tile, and this box clips its contents already. The intrinsic
        size is the height a tile has in a strip of three at the dock's usual
        width, and only until the tile has been drawn once — `auto` keeps the
        size it really was after that.
      -->
      <div class="relative overflow-hidden rounded-xs [contain-intrinsic-size:auto_10rem] [content-visibility:auto]">
        <CanvasPageArt :page="page" preview />
        <!--
          The ring is drawn *inward*, and that is the point: a ring outside the
          box grows the thumbnail by its own width the moment a page is picked —
          a page that looks bigger for being selected — and gets clipped
          wherever the panel's edges are tight. Inward, every cell has the same
          footprint whatever is selected. It lives on an overlay rather than on
          the box itself because an inset shadow paints under the box's
          children, and the image is all of them.
        -->
        <div
          class="pointer-events-none absolute inset-0 rounded-xs transition-all ring-inset"
          :class="dropping || current
            ? 'ring-primary ring-2'
            : 'ring-border group-hover:ring-muted-foreground ring-1'"
        />

        <!--
          A file being held over an absent page. Says what letting go will do,
          because "drop a file on a page" is the one gesture here whose meaning
          is not obvious from the thing under the pointer.
        -->
        <div
          v-if="dropping"
          class="bg-background/85 text-primary pointer-events-none absolute inset-0 flex items-center
            justify-center rounded-xs text-center text-[10px] font-medium"
        >
          Use as this page
        </div>
      </div>
      <!--
        `min-w-0`, or the name decides the column: a grid item's automatic
        minimum is its content's min-content, and a file name is one long
        unbreakable word — wide enough, it pushes the whole cell (and the
        aspect-ratio'd thumbnail above it) past the track. Selecting a page sets
        its name in `font-medium`, which was the last few tenths of a pixel —
        the selected page really was drawn bigger than its row.
      -->
      <div class="flex min-w-0 items-baseline justify-between gap-1">
        <input
          v-if="renaming"
          :ref="focusName"
          v-model="draft"
          class="ring-primary w-full min-w-0 rounded-xs bg-transparent px-0.5 text-[10px] ring-1 outline-none"
          aria-label="Page name"
          @click.stop
          @dblclick.stop
          @keydown.enter.prevent="emit('commit', page.id, draft)"
          @keydown.esc.prevent="emit('cancel')"
          @blur="emit('commit', page.id, draft)"
        >
        <template v-else>
          <span
            class="truncate text-[10px]"
            :class="current ? 'text-foreground font-medium' : 'text-muted-foreground'"
            title="Double-click to rename"
            @dblclick.stop="emit('rename', page)"
          >
            {{ page.name }}
          </span>
          <span class="text-muted-foreground font-mono text-[10px]">{{ page.blocks.length }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
