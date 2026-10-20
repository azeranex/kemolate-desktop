<script setup lang="ts">
/**
 * One workspace: the chapter that is open, its canvas, and the controls around
 * it — the web build's workspace page, carried across as far as opening and
 * looking at a chapter goes.
 *
 * Here: opening a folder, files or a PDF (the toolbar's button, File › Open,
 * or a drop on the canvas — `CanvasDrop`); restoring what was open last time,
 * or offering to reopen a folder the system wants asked about again; hashing
 * the pages once they are listed (`identify`); landing on the page this window
 * was last on (`usePagePosition`); the pager and the page picker; the zoom in
 * the status bar; and the page's name and size.
 *
 * And what has been done to it coming back: the reading and the repairs, by
 * the web build's `restoreChain` (below).
 *
 * Not here yet, each arriving with what it drives: the layer, glossary and
 * cast restores, and the wait that keeps a page hidden until its cleaning is
 * ready (`composing`); undo and redo;
 * the auto run and the AI cost tally; workspace settings. And never, because
 * the desktop app has no cloud: signing in, the swarm, sharing and moving to
 * the cloud, and the live syncs.
 *
 * `NuxtLayout name="workspace"` is the workspace layout, imported here — there
 * is no layout system, only the one layout.
 */
import {
  BookImageIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  Redo2Icon,
  Undo2Icon,
} from '@lucide/vue'

import Workspace from '~/layouts/Workspace.vue'

const { open, pages, title, at, page, selection, epoch, go, zoomAt, resetView } = useComic()
const { kind, pending, restoring, openFolder, restore, reopen, forget, identify } = useLibrary()
const { tool } = useTools()
const { restore: restoreBlocks } = useOcr()
const { restore: restoreCached } = useBlockCache()
const { restore: restorePatches, settings: cleanSettings, showKept } = useClean()
const { restore: restorePosition, placing } = usePagePosition()

const label = computed(() => TOOLS.find((t) => t.id === tool.value)?.label ?? 'Select')

onMounted(() => restore().then(() => restorePosition()))

/*
 * What has been done to the chapter comes back after the chapter does — the web
 * build's `restoreChain`, with the steps a local workspace has: the reading
 * (`useOcr.restore`, which is the server's copy and returns at once without
 * one, then this machine's own, `useBlockCache.restore`), and the repairs
 * (`useClean.restore`). The web build's page-list sync, swarm announce and
 * layer restore are not here yet or not at all — see the header.
 *
 * One chain at a time; a trigger that lands mid-run asks for one more pass
 * rather than a second chain racing the first.
 */
let running: Promise<void> | null = null
let again = false
let begun = 0
const read = ref(0)

function settle (): Promise<void> {
  if (running) {
    again = true

    return running
  }

  running = (async () => {
    do {
      again = false
      await restoreChain()
    } while (again)
  })().finally(() => { running = null })

  return running
}

async function restoreChain () {
  const pass = ++begun

  await restoreBlocks()
  await restoreCached()

  read.value = pass

  await restorePatches()
}

/*
 * Run it as the pages arrive, as their hashes land — everything kept is filed
 * by hash, so a page without one has nothing to look up yet — and whenever the
 * chapter is opened again (`epoch`), which the counts cannot see: reopening
 * gives the same pages back as new objects with no blocks on them.
 */
watch(
  [
    () => pages.value.length,
    () => pages.value.filter((entry) => entry.scan?.hash).length,
    epoch,
  ],
  () => { settle() },
)

// The cleaner is half of every repair's name, so changing it looks them up again.
watch(() => [cleanSettings.value.model, cleanSettings.value.segmenter], () => { restorePatches() })

// The page on screen's cleaning, from its record of what it last showed — see `useClean.showKept`.
watch(() => [page.value?.id, page.value?.scan?.hash], () => { showKept(page.value) }, { immediate: true })

/**
 * Every page gets its hash once it is listed — which is what everything keyed
 * by content (thumbnails, previews, repairs) waits on. On the count and on the
 * epoch, so a chapter opened over another of the same length is identified too.
 */
watch([() => pages.value.length, epoch], () => { identify() })

const showing = computed(() => open.value && !restoring.value)

const heading = computed(() => {
  if (restoring.value) return 'Kemolate'
  if (open.value) return title.value

  return pending.value?.title ?? 'No comic open'
})

const dimensions = computed(() => {
  const scan = page.value?.scan

  if (!scan?.width || !scan?.height) return null

  return `${scan.width} × ${scan.height}`
})

const held = computed(() => {
  if (kind.value === 'handle') return 'In your folder'
  if (kind.value === 'copy') return 'Copied into this app'

  return null
})

function scale (by: number) {
  zoomAt(by, undefined, true)
}
</script>

<template>
  <Workspace>
    <CanvasDrop>
      <!--
        Nothing at all until we know what is open — see the web build: drawing a
        stand-in meanwhile looks a great deal like losing the real chapter.
      -->
      <div v-if="restoring" class="size-full" />

      <UEmpty v-else-if="!open" class="size-full">
        <UEmptyHeader>
          <UEmptyMedia variant="icon">
            <BookImageIcon />
          </UEmptyMedia>

          <!--
            A remembered folder is not an open one: the handle survived, the
            permission did not, and asking for it back is only allowed from a
            click. So the offer is the button, and the button is the consent.
          -->
          <template v-if="pending">
            <UEmptyTitle>{{ pending.title }}</UEmptyTitle>
            <UEmptyDescription>
              Last opened from a folder on this computer. Kemolate needs your
              say-so to read it again.
            </UEmptyDescription>
            <UEmptyContent class="flex-row gap-2">
              <UButton size="sm" @click="reopen">
                <FolderOpenIcon class="size-4" /> Reopen folder
              </UButton>
              <UButton variant="ghost" size="sm" @click="forget">
                Forget it
              </UButton>
            </UEmptyContent>
          </template>

          <template v-else>
            <UEmptyTitle>No comic open</UEmptyTitle>
            <UEmptyDescription>
              Drop a folder of pages — or a PDF of them — here to start
              translating. They stay on this computer.
            </UEmptyDescription>
            <UEmptyContent>
              <UButton variant="outline" size="sm" @click="openFolder">
                <FolderOpenIcon class="size-4" /> Open folder
              </UButton>
            </UEmptyContent>
          </template>
        </UEmptyHeader>
      </UEmpty>

      <!--
        Laid out but not shown until the page this window was last on has been
        turned to — otherwise page one is drawn for a frame or two first.
      -->
      <CanvasBoard v-else :class="{ invisible: placing }" />
    </CanvasDrop>

    <template #toolbar>
      <div class="flex min-w-0 items-center gap-2">
        <!-- Where you are, and the way to open something else here. -->
        <UButton variant="ghost" size="sm" class="min-w-0" @click="openFolder">
          <FolderOpenIcon class="size-4 flex-none" />
          <span class="truncate">{{ heading }}</span>
        </UButton>

        <div class="bg-border h-5 w-px flex-none" />

        <!-- Undo and redo arrive with what they take back; greyed until then. -->
        <UButton variant="ghost" size="icon-sm" disabled aria-label="Undo" title="Undo (Ctrl+Z)">
          <Undo2Icon class="size-4" />
        </UButton>
        <UButton variant="ghost" size="icon-sm" disabled aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
          <Redo2Icon class="size-4" />
        </UButton>

        <div v-if="showing" class="bg-border h-5 w-px flex-none" />

        <template v-if="showing">
          <UButton
            variant="ghost"
            size="icon-sm"
            :disabled="at === 0"
            aria-label="Previous page"
            @click="go(at - 1)"
          >
            <ChevronLeftIcon class="size-4" />
          </UButton>
          <PagePicker />
          <UButton
            variant="ghost"
            size="icon-sm"
            :disabled="at === pages.length - 1"
            aria-label="Next page"
            @click="go(at + 1)"
          >
            <ChevronRightIcon class="size-4" />
          </UButton>
        </template>
      </div>
    </template>

    <!-- the tool that is out — its settings join it with the paint engine -->
    <template #context>
      <span class="text-foreground font-medium">{{ label }}</span>
    </template>

    <!-- and the state of it, along the bottom -->
    <template #status>
      <template v-if="showing">
        <span class="whitespace-nowrap">{{ selection.length ? `${selection.length} selected` : 'Nothing selected' }}</span>
        <div class="bg-border mx-1 h-4 w-px" />
        <UButton variant="ghost" size="icon-xs" aria-label="Zoom out" @click="scale(1 / 1.25)">
          <MinusIcon class="size-3.5" />
        </UButton>
        <WorkspaceZoom />
        <UButton variant="ghost" size="icon-xs" aria-label="Zoom in" @click="scale(1.25)">
          <PlusIcon class="size-3.5" />
        </UButton>
        <UButton variant="ghost" size="icon-xs" aria-label="Fit page" @click="resetView">
          <MaximizeIcon class="size-3.5" />
        </UButton>
      </template>

      <div class="flex-1" />

      <!--
        Which of the two ways the pages are being held. Worth a line: working on
        the user's own files and working on a copy of them are different things
        to be doing.
      -->
      <template v-if="showing">
        <span v-if="held" class="text-muted-foreground hidden whitespace-nowrap @3xl:inline">{{ held }}</span>
        <div v-if="held" class="bg-border hidden h-4 w-px @3xl:block" />

        <span class="hidden max-w-40 truncate font-mono @sm:inline">{{ page?.name }}</span>

        <template v-if="dimensions">
          <div class="bg-border hidden h-4 w-px @2xl:block" />
          <span class="hidden font-mono whitespace-nowrap tabular-nums @2xl:inline">{{ dimensions }}</span>
        </template>
      </template>
    </template>
  </Workspace>
</template>
