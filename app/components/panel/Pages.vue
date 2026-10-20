<script setup lang="ts">
/**
 * Every page of the comic, as thumbnails, with the one being worked on marked.
 *
 * The same drawing as the canvas at a twentieth of the size — one component,
 * so a page cannot look like one thing here and another thing there. The count
 * beside each is how many blocks were found on it, which is the only thing
 * about a page worth knowing before opening it.
 *
 * The panel is also where the chapter itself is edited: a page dragged to
 * somewhere else in the reading order, a name double-clicked and retyped, a
 * blank white page added after the one being looked at, and files dropped in
 * from the desktop. All of them go through `useLibrary`, which is what makes
 * them still true tomorrow.
 *
 * ## Two drags, and they must not be confused
 *
 * A thumbnail dragged within the panel is a *reorder*; a file dragged in from
 * outside is an *addition*. They land on the same handlers and mean opposite
 * things — one rearranges what is here, the other brings more — so every one of
 * them is gated on which is in flight. `dragId` marks ours; `Files` in the
 * transfer's types marks the desktop's. Reading only the first is how dropping
 * a folder onto the strip used to reorder page four onto itself and lose the
 * folder entirely.
 */
import { ImageDownIcon, LoaderCircleIcon, PlusIcon } from '@lucide/vue'

import PanelPageTile from '~/components/panel/PageTile.vue'

// Imported rather than auto-imported: a new component is unknown to the running
// dev server until it restarts.

const { pages, at, go } = useComic()
const { addBlank, arrange, rename, discard, addImages, link, failed } = useLibrary()

/**
 * Take a page out, asking first.
 *
 * The only destructive thing in this panel, and the confirmation names the page
 * rather than saying "this page" — the tiles are small and the one under the
 * pointer is not always the one in mind. The scan itself is not deleted from
 * anybody's folder; a copied chapter loses its copy, which is said plainly.
 */
/**
 * The page being asked about, and whether its removal is under way.
 *
 * An in-app dialog rather than `window.confirm`, which is what this used to be
 * and is the likeliest reason the button appeared dead however it was pressed.
 * A native dialog is not the page's to rely on: Chrome offers "prevent this
 * page from creating additional dialogs" on the second one an origin shows, and
 * once that is ticked — which anybody deleting a few pages in a row will do
 * without much thought — every later `confirm()` returns false the instant it
 * is called. No dialog, no error, no delete, for the rest of that tab's life.
 * The button responds to the press and then quietly does nothing, which is
 * exactly how it was described.
 *
 * `index.vue` already asks this way for the equally destructive "delete a
 * workspace", down to keeping the dialog open while the request is in flight —
 * see the note there on why the action is a plain button.
 */
const asked = ref<ComicPage | null>(null)
const working = ref(false)

/** A tile's delete, pressed — asked about first, see `asked`. */
function askRemove (item: ComicPage) {
  asked.value = item
}

async function remove () {
  const item = asked.value

  if (!item) return

  working.value = true

  try {
    await discard(item.id)
    asked.value = null
  } finally {
    working.value = false
  }
}

/**
 * Dragging a thumbnail to somewhere else in the reading order — the same
 * arrangement as the block list, sideways: the whole cell is the handle, and
 * `dropAt` is a gap rather than a cell, nought before the first and the length
 * after the last.
 */
const dragId = ref<string | null>(null)
const dropAt = ref<number | null>(null)

function onDragStart (id: string, event: DragEvent) {
  dragId.value = id

  if (!event.dataTransfer) return

  // Firefox starts no drag at all from an empty transfer.
  event.dataTransfer.setData('text/plain', id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver (index: number, event: DragEvent) {
  if (!dragId.value) return

  // Without this the browser reads the cell as refusing the drop.
  event.preventDefault()

  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()

  // Past the middle of a cell is a drop after it, which is the same gap as
  // before the next one.
  dropAt.value = event.clientX < box.left + box.width / 2 ? index : index + 1
}

function onDrop () {
  if (dragId.value && dropAt.value !== null) arrange(dragId.value, dropAt.value)

  endDrag()
}

function endDrag () {
  dragId.value = null
  dropAt.value = null
}

/* ---------- pages dragged in from outside ---------- */

/** Files, rather than a thumbnail being dragged around inside the panel. */
function hasFiles (event: DragEvent) {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/**
 * Counted rather than set, because dragging across the strip's own children
 * fires a leave for the one being left before the enter for the one arrived at
 * — a flag flickers off between every tile on the way in. The same counter
 * `CanvasDrop` keeps, for the same reason.
 */
const over = ref(0)
const reading = ref(false)

function onFilesEnter (event: DragEvent) {
  if (hasFiles(event)) over.value++
}

function onFilesLeave () {
  over.value = Math.max(0, over.value - 1)
}

function onFilesOver (event: DragEvent) {
  if (!hasFiles(event) || !event.dataTransfer) return

  // A dragover that is not defaulted out of is a drop that never happens — and
  // "copy" rather than "move", because nothing leaves the folder it came from.
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

/**
 * Added to the chapter rather than opened as one — see `useLibrary.addImages`.
 *
 * Dropping on the canvas means "work on this instead" and replaces what is
 * open. Dropping on the page list means "and these too". Same files, opposite
 * intent, and the target is the only thing that says which.
 */
async function onFilesDrop (event: DragEvent) {
  over.value = 0

  if (!hasFiles(event) || !event.dataTransfer) return

  reading.value = true

  // Started before anything is awaited: a `DataTransfer` is emptied the moment
  // this handler returns, so the read has to have taken hold of it by then.
  const found = imagesFrom(event.dataTransfer)

  try {
    await addImages(await found)
  } catch (error) {
    // A drop handler that throws throws into nothing — the browser has nowhere
    // to put it, so the drop simply appears not to have happened.
    failed('Those pages couldn’t be read.', error)
  } finally {
    reading.value = false
  }
}

/* ---------- giving an absent page its file ---------- */

/**
 * A page whose picture is not on this computer, offered the file it is.
 *
 * The counterpart to the drop above, and the two must not be confused: dropping
 * onto the panel adds pages, and this hands one file to one page that already
 * exists. They were the same gesture once — a drop was matched to whatever row
 * held the same bytes — and separating them is what stopped a chapter opened on
 * a second computer from doubling itself the moment somebody dragged their
 * folder in. See `link` in `useLibrary`.
 *
 * Two ways in, because they suit different moments: a file dragged onto the
 * page itself, which is exact and needs no dialog, and a button that opens the
 * picker, for somebody who has not got a window of files open beside this one.
 */
const picker = useTemplateRef<HTMLInputElement>('picker')

/** Which page the picker was opened for — it can only be about one. */
const locating = ref<ComicPage | null>(null)

/** A file that is a page but not, by its bytes, *this* page — see `link`. */
const unlike = ref<{ page: ComicPage, file: File } | null>(null)

/**
 * The last thing that was asked about, kept for as long as the dialog is on
 * screen rather than only while the question stands.
 *
 * A dialog does not leave the moment it is closed — it animates out — and its
 * words come from the same ref that decides whether it is open. Reading them
 * straight off `unlike` therefore emptied the sentence a frame before the panel
 * disappeared, so a reader who pressed "Use it anyway" watched the file's name
 * blink out of the question they had just answered. This holds the answer still
 * while the box goes.
 */
const asking = ref<{ page: ComicPage, file: File } | null>(null)

watch(unlike, (now) => { if (now) asking.value = now })

function locate (item: ComicPage) {
  locating.value = item
  picker.value?.click()
}

async function chosen (event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const item = locating.value

  // Cleared before anything is awaited, and the input with it: the same file
  // picked twice in a row fires no `change` at all unless the value is reset.
  locating.value = null
  input.value = ''

  if (file && item) await give(item, file)
}

/**
 * Hand a file to a page, and ask about it only when there is something to ask.
 *
 * A file whose bytes are what the workspace recorded goes in without a word —
 * there is nothing to decide. One that does not comes back as `mismatch` with
 * nothing changed, and only then is the reader interrupted, because only they
 * know whether that is the wrong page or the same page exported again.
 */
async function give (item: ComicPage, file: File, anyway = false) {
  const done = await link(item.id, file, { anyway }).catch((error: unknown) => {
    failed('That file couldn’t be linked to the page.', error)

    return 'unknown' as const
  })

  if (done === 'mismatch') {
    unlike.value = { page: item, file }

    return
  }

  unlike.value = null

  if (done === 'linked') toast.success(`“${item.name}” is here now`)
}

/**
 * A file dragged onto one page rather than onto the panel.
 *
 * Only for a page that has no picture — a tile with art on it is a reorder
 * target and nothing else — and the event is stopped either way it is taken, or
 * the panel behind would add the same file as a new page a moment later.
 */
const dropOn = ref<string | null>(null)

function onTileOver (item: ComicPage, event: DragEvent) {
  if (!hasFiles(event) || !isOffline(item) || !event.dataTransfer) return

  event.preventDefault()
  event.stopPropagation()

  event.dataTransfer.dropEffect = 'copy'
  dropOn.value = item.id
}

async function onTileDrop (item: ComicPage, event: DragEvent) {
  if (!hasFiles(event) || !isOffline(item) || !event.dataTransfer) return

  event.preventDefault()
  event.stopPropagation()

  dropOn.value = null
  over.value = 0
  reading.value = true

  // Taken hold of before anything is awaited — a `DataTransfer` is emptied the
  // moment the handler returns. Through `imagesFrom` rather than `files[0]` so
  // that a page of a PDF is as droppable here as a loose image.
  const found = imagesFrom(event.dataTransfer)

  try {
    const file = (await found).images[0]?.file

    if (file) await give(item, file)
  } catch (error) {
    failed('That file couldn’t be read.', error)
  } finally {
    reading.value = false
  }
}

/*
 * The two drags meet on the same cell, so the cell asks which is in flight
 * before it does anything — `dragId` marks a thumbnail being rearranged, and
 * anything else with files in it is a file being offered to this page. Written
 * as one handler each rather than two bindings, because a cell that ran both
 * would start a reorder and a link from one drop.
 */
function onCellOver (item: ComicPage, index: number, event: DragEvent) {
  if (dragId.value) return onDragOver(index, event)

  onTileOver(item, event)
}

function onCellDrop (item: ComicPage, event: DragEvent) {
  if (dragId.value) return onDrop()

  return onTileDrop(item, event)
}

/** A file dragged off the page it was being held over. */
function onCellLeave (id: string) {
  if (dropOn.value === id) dropOn.value = null
}

/** Which side of the cell at `index` the insertion bar belongs on. */
function edgeAt (index: number) {
  if (dropAt.value === null) return null
  if (dropAt.value === index) return 'left'
  // Only the last cell can be dropped past, and it draws that itself.
  if (dropAt.value > index && index === pages.value.length - 1) return 'right'

  return null
}

/**
 * Renaming, in place. Double-click the name, type, Enter or click away keeps
 * it, Escape does not. The cell stops being draggable meanwhile, so selecting
 * text does not pick the page up instead. The words being typed are the tile's
 * own — see `PanelPageTile` — and arrive here when they are kept.
 */
const editing = ref<string | null>(null)

function beginRename (item: ComicPage) {
  editing.value = item.id
}

function commitRename (id: string, draft: string) {
  // Down first: the Enter that commits is followed by the blur of the field
  // going away, and the second arrival must find nothing left to do.
  if (editing.value !== id) return

  editing.value = null

  const name = draft.trim()
  const was = pages.value.find((page) => page.id === id)?.name

  if (name && name !== was) rename(id, name)
}

function cancelRename () {
  editing.value = null
}
</script>

<template>
  <!--
    The whole panel is the target, not the gaps between tiles: a strip of
    thumbnails leaves almost no empty space to aim at, and a drop zone you have
    to find is one people give up on. The tile handlers below ignore file drags
    (see `onDragOver`), so this catches them on the way past.
  -->
  <div
    class="relative grid gap-3"
    @dragenter="onFilesEnter"
    @dragleave="onFilesLeave"
    @dragover="onFilesOver"
    @drop.prevent="onFilesDrop"
  >
    <!--
      A tile per page — see `PanelPageTile`, which says why each is a component
      of its own. Every handler here is a named function taking the page it is
      about, so no tile is handed a new one on a render of the strip.
    -->
    <div class="grid grid-cols-3 gap-2">
      <PanelPageTile
        v-for="(item, index) in pages"
        :key="item.id"
        :page="item"
        :index="index"
        :current="index === at"
        :dragging="dragId === item.id"
        :edge="edgeAt(index)"
        :dropping="dropOn === item.id"
        :renaming="editing === item.id"
        @go="go"
        @remove="askRemove"
        @locate="locate"
        @dragstart="onDragStart"
        @over="onCellOver"
        @leave="onCellLeave"
        @drop="onCellDrop"
        @dragend="endDrag"
        @rename="beginRename"
        @commit="commitRename"
        @cancel="cancelRename"
      />
    </div>

    <UButton variant="secondary" size="sm" :disabled="!pages.length" @click="addBlank">
      <PlusIcon class="size-4" />
      Add blank page
    </UButton>

    <!--
      Over the strip rather than in place of it: what you are dropping *into* is
      the thing worth still being able to see, and a target that replaced the
      thumbnails would be a target that moved out from under the pointer.
    -->
    <div
      v-if="over > 0 || reading"
      class="bg-background/80 border-primary pointer-events-none absolute -inset-1 z-30 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed backdrop-blur-xs"
    >
      <LoaderCircleIcon v-if="reading" class="text-primary size-6 animate-spin" />
      <ImageDownIcon v-else class="text-primary size-6" />

      <p class="text-xs font-medium">
        {{ reading ? 'Reading pages…' : 'Add these to the chapter' }}
      </p>
      <p class="text-muted-foreground max-w-48 text-center text-[10px]">
        They join the pages already here. Drop on the canvas instead to open them as a new chapter.
      </p>
    </div>

    <!--
      The picker for "find this page's file". One input for the whole panel
      rather than one per tile — `locating` remembers which page asked — because
      forty pages would otherwise be forty file inputs in the document.
    -->
    <input
      ref="picker"
      type="file"
      accept="image/*"
      class="hidden"
      @change="chosen"
    >

    <!--
      A file that is a picture but not this page's picture. Asked rather than
      refused: the workspace's hash is what somebody else's copy of the chapter
      hashes to, and a page exported again at another quality is a different
      hash for the same page — which only the reader can tell from having picked
      the wrong file entirely.
    -->
    <UAlertDialog
      :open="!!unlike"
      @update:open="(open: boolean) => { if (!open) unlike = null }"
    >
      <UAlertDialogContent>
        <UAlertDialogHeader>
          <UAlertDialogTitle>That isn’t the file recorded for “{{ asking?.page.name }}”</UAlertDialogTitle>
          <UAlertDialogDescription>
            “{{ asking?.file.name }}” is a picture, but not the one this chapter
            was read from — so it may be another page, or the same page saved out
            again. Linking it puts it behind this page’s boxes here. Everybody
            else keeps the scan they already have, and the chapter goes on asking
            for that one.
          </UAlertDialogDescription>
        </UAlertDialogHeader>
        <UAlertDialogFooter>
          <UAlertDialogCancel>Cancel</UAlertDialogCancel>
          <UButton @click="unlike && give(unlike.page, unlike.file, true)">
            Use it anyway
          </UButton>
        </UAlertDialogFooter>
      </UAlertDialogContent>
    </UAlertDialog>

    <!--
      Kept open while the removal is in flight — see `index.vue`, which makes
      the same argument for the same reason: a dialog that has already gone
      leaves a failure to be explained by a toast beside a page that is still
      there.
    -->
    <UAlertDialog
      :open="!!asked"
      @update:open="(open: boolean) => { if (!open && !working) asked = null }"
    >
      <UAlertDialogContent>
        <UAlertDialogHeader>
          <UAlertDialogTitle>Remove “{{ asked?.name }}” from this chapter?</UAlertDialogTitle>
          <UAlertDialogDescription>
            Its blocks, translations and cleanup go with it, for everybody in
            this workspace. The scan itself stays in your folder, and the
            reading comes back if the same file is added again.
          </UAlertDialogDescription>
        </UAlertDialogHeader>
        <UAlertDialogFooter>
          <UAlertDialogCancel :disabled="working">
            Cancel
          </UAlertDialogCancel>
          <UButton variant="destructive" :disabled="working" @click="remove">
            <USpinner v-if="working" class="size-4" />
            Remove
          </UButton>
        </UAlertDialogFooter>
      </UAlertDialogContent>
    </UAlertDialog>
  </div>
</template>
