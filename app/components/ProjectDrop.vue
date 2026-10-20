<script setup lang="ts">
/**
 * The workspace list as somewhere to drop a project file.
 *
 * `canvas/Drop.vue`'s sibling, and the division between them is the division
 * between the two pages. That one drops *pages into a workspace* — it has a
 * chapter to replace and `useLibrary` to replace it with. This one drops a
 * whole workspace onto a list of them, where there is no chapter, no library
 * and no workspace in the address at all.
 *
 * Which is why it does not open anything itself. It sniffs the drop, hands the
 * file back, and the page it sits on decides what a new workspace is — that
 * decision has a long note of its own on `start` in `pages/index.vue` (a
 * workspace signed in is the server's from the moment it exists; signed out it
 * is an id and somewhere to go), and a second copy of it here would be a second
 * chance to get it wrong.
 *
 * ## It wraps rather than sits beside
 *
 * The target is the whole page — the header, the list, the space under it —
 * because "drop this somewhere" has no obvious spot on a page that is otherwise
 * a list of links, and a strip you have to find is a feature nobody finds.
 *
 * ## Anything else is refused out loud
 *
 * A folder of scans dropped here is a reasonable thing to try and the wrong
 * thing to guess at: it would mean minting a workspace and opening a chapter in
 * it, which is a different gesture with a different result, and one the reader
 * has a button for. Saying so beats a drop that appears not to have happened.
 */
import { LoaderCircleIcon, PackageOpenIcon } from '@lucide/vue'

import { isProjectFile, PROJECT_EXTENSION } from '~/utils/project'

const emit = defineEmits<{ project: [file: File] }>()

/** Whether the page is busy making the workspace this drop is going into. */
const { busy } = defineProps<{ busy?: boolean }>()

/**
 * Counted rather than set, because dragging across the page's own children
 * fires a leave for the one being left before the enter for the one being
 * arrived at — a flag flickers off between every element on the way in.
 */
const depth = ref(0)

/** Files, rather than the text and links dragged out of another page. */
function hasFiles (event: DragEvent) {
  return event.dataTransfer?.types.includes('Files') ?? false
}

function onEnter (event: DragEvent) {
  if (hasFiles(event)) depth.value++
}

function onLeave () {
  depth.value = Math.max(0, depth.value - 1)
}

function onOver (event: DragEvent) {
  if (!hasFiles(event) || !event.dataTransfer) return

  // Says "copy" under the pointer, and — more to the point — a dragover that is
  // not defaulted out of is a drop that never happens.
  event.dataTransfer.dropEffect = 'copy'
}

function onDrop (event: DragEvent) {
  depth.value = 0

  // Read straight out of the event and not after an await: a `DataTransfer` is
  // emptied when the handler returns, so anything reached for later is gone.
  const dropped = [...(event.dataTransfer?.files ?? [])]

  if (!dropped.length) return

  const project = dropped.find(isProjectFile)

  if (!project) {
    // Named, and with the way forward, because the two mistakes behind this are
    // different: one reader has the wrong file, the other has the right idea
    // and the wrong page.
    toast.warning('That isn’t a project file', {
      description: `Drop a ${PROJECT_EXTENSION} file here. A folder of scans goes into a workspace — make one first, then drop the pages onto its canvas.`,
    })

    return
  }

  emit('project', project)
}

const showing = computed(() => depth.value > 0 || Boolean(busy))
</script>

<template>
  <div
    class="relative min-h-dvh"
    @dragenter="onEnter"
    @dragleave="onLeave"
    @dragover.prevent="onOver"
    @drop.prevent="onDrop"
  >
    <slot />

    <!--
      Over the list rather than in place of it, exactly as the canvas's does:
      what you are dropping onto is worth still being able to see, and a target
      that replaced the page would be a target that moved out from under the
      pointer.

      `fixed` rather than `absolute` because this wraps a column that scrolls —
      an overlay pinned to the content would sit off-screen for anybody with
      more workspaces than fits, which is precisely the reader most likely to be
      moving one between machines.
    -->
    <div
      v-if="showing"
      class="bg-background/70 border-primary pointer-events-none fixed inset-4 z-50 flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed backdrop-blur-xs"
    >
      <LoaderCircleIcon v-if="busy" class="text-primary size-8 animate-spin" />
      <PackageOpenIcon v-else class="text-primary size-8" />

      <p class="text-sm font-medium">
        {{ busy ? 'Making a workspace…' : 'Drop a project to open it' }}
      </p>
      <p class="text-muted-foreground max-w-72 text-center text-xs">
        A <code>{{ PROJECT_EXTENSION }}</code> file opens in a new workspace — its pages, its reading,
        its translations and all its retouching.
      </p>
    </div>
  </div>
</template>
