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
 * And what has been done to it coming back: the reading, the layer stacks and
 * the repairs, by the web build's `restoreChain` (below); the target language,
 * reading direction, AI ledger, glossary and cast; and a project file handed
 * over to be opened here.
 *
 * The auto run is the header's first action (`AutoRun`), and the AI cost of the
 * page and of the next press sit in the status bar.
 *
 * The page is held hidden until it can be shown whole (`composing`), and every
 * other page's preview and sketch is made in the background.
 *
 * And workspace settings — name, reading direction, what is kept where — beside
 * the folder button (`WorkspaceSettings`).
 *
 * The workspace's record — its pages, readings, translations, layer stacks,
 * strokes, glossary and cast — is the web build's cloud half, kept in this
 * machine's own database (`electron/database.ts`) rather than on a server:
 * `look` fetches it, `syncPages` and the syncs mounted below keep it, and a
 * page it knows whose picture is not here is still shown (`showMissing`). Not
 * here, because the desktop has neither: the swarm, sharing, and the MCP
 * errands.
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

import { patchStands } from '~/composables/useClean'
import Workspace from '~/layouts/Workspace.vue'
import { repairOvers } from '~/utils/raster/engine/overs'
import { fitLevel, fittedHeight } from '~/utils/raster/plan'
import { cleaningSignature, makePreviews } from '~/utils/raster/previews'

// Walking in from another workspace lets go of the last one's state before any
// of it can be drawn or written under this one's name — see `useWorkspaceReset`.
// First, before anything below reads that state.
useWorkspaceReset()

const { open, pages, title, at, page, selection, epoch, room, go, zoomAt, resetView } = useComic()
const { kind, pending, restoring, openFolder, restore, reopen, forget, identify } = useLibrary()
const { tool } = useTools()
const { shared, standing, look, syncPages, showMissing, fill: fillPages } = useShared()
const { restore: restoreBlocks } = useOcr()
const { restore: restoreCached } = useBlockCache()
const { restore: restoreLayers } = useLayerCache()
const { restore: restorePatches, settings: cleanSettings, showKept, keepShown, patches: shownRepairs, running: cleaning } = useClean()
const { restore: restorePlaced, asked: placedAsked } = usePlacedImages()
const { restore: restoreTarget, target } = useTargetLanguage()
const { restore: restoreDirection } = useReadingDirection()
const { load: loadGlossary } = useGlossary()
const { load: loadCast } = useCast()
const { restore: restoreUsage, total: pageCost } = useAiUsage()

/*
 * What the next press is expected to cost, for the status bar. Safe to ask for
 * here: `useTranslate` registers no watcher of its own, so a second call beside
 * the Translate panel's is two reads of the same state — see the web build.
 */
const { estimate } = useTranslate()
const { restore: restorePosition, placing } = usePagePosition()
const { claim: claimProject } = useProjectFile()

const label = computed(() => TOOLS.find((t) => t.id === tool.value)?.label ?? 'Select')

const { canUndo, canRedo, undo, redo } = useUndo()

// Cmd+Z across the whole workspace — the stacks live in `useUndo`, keyed by
// workspace, so they survive page turns and belong to nobody but this browser.
useUndoShortcuts()

// And Delete/Backspace on the selection, which is the key everybody reaches for
// before they look for a button — see `useDeleteShortcut`.
useDeleteShortcut()

// The workspace's record, kept as it changes — the web build's four, mounted
// once here rather than wired into each of the dozen places that edit a page:
// a block back to its row (`useBlockSync`), what it says and how it is set
// (`useTranslationSync`), what the database answered being laid in
// (`useLiveSync`), and the layer stack (`useLayerSync`).
useBlockSync()
useTranslationSync()
useLiveSync()
useLayerSync()

/*
 * Whether the record has been asked for on the way in — so that "no record"
 * means there is none, rather than that the answer has not come back yet. A
 * workspace with none is one still kept in this window's storage, and is moved
 * into the database (`useMoveIn`) at the end of a restore pass.
 */
const looked = ref(false)
const { moveIn } = useMoveIn()

/*
 * The way in — the web build's gather: what was open, the workspace's record
 * (`look`), and this machine's last target language, reading direction and AI
 * ledger, together. Then the pages the record holds that no file here accounts
 * for (`showMissing`), which needs both answers; then back to the page this
 * window was on, which may be one of those; and last of all a project file
 * handed over to be opened here (`useProjectFile.claim`) — after the restore,
 * which is what lowers `restoring`; see the web build.
 */
onMounted(() => Promise.all([restore(), look().then(() => { looked.value = true }), restoreTarget(), restoreDirection(), restoreUsage()])
  .then(() => { showMissing() })
  .then(() => restorePosition())
  .then(() => claimProject()))

/*
 * The chapter's glossary, which goes out with every page put through the model,
 * and its cast — read here rather than by the panels that draw them, because a
 * run reads both and those panels may never have been opened. Both wait on the
 * workspace's record; the glossary on the target language too, since its target
 * half is written in one. See the web build.
 */
watch([standing, target], () => { loadGlossary() }, { immediate: true })
watch(standing, () => { loadCast() }, { immediate: true })

/*
 * Desktop: the name the reader gave this workspace, laid over the chapter each
 * time one is opened in it — see `Workspace.named`. Opening names a chapter
 * after its folder (or "6 pages"), which in the web build is what a renamed local
 * workspace went back to on every load; here every workspace is local.
 */
const { namedOf } = useWorkspaces()

watch([epoch, open], async ([, showing]) => {
  if (!showing) return

  const named = await namedOf(String(useRoute().params.workspaceId ?? ''))

  if (named && open.value) title.value = named
}, { immediate: true })

/*
 * The bytes behind the pictures a stack refers to — see `usePlacedImages`, and
 * the web build for why it is watched here rather than chained.
 */
watch(placedAsked, () => { restorePlaced() }, { immediate: true })

/*
 * What has been done to the chapter comes back after the chapter does — the web
 * build's `restoreChain`: the page list agreed with the record (`syncPages`)
 * and the pages it has that are not here laid in (`showMissing`); the reading
 * (`useOcr.restore`, the record's, then `useBlockCache.restore` for a
 * workspace still kept in this window's storage); a local workspace's layer
 * stacks; and the repairs (`useClean.restore`). The web build's swarm announce
 * is not here — there is nobody to tell.
 *
 * One chain at a time; a trigger that lands mid-run asks for one more pass
 * rather than a second chain racing the first.
 */
let running: Promise<void> | null = null
let again = false
let begun = 0
const read = ref(0)

const opening = useOpening()

function settle (): Promise<void> {
  if (running) {
    again = true

    return running
  }

  // The chain as a whole, for the status bar: it is what stops "not cleaned"
  // being said in the gap between one stage ending and the next starting.
  opening.begin('opening')

  running = (async () => {
    do {
      again = false
      await restoreChain()
    } while (again)
  })().finally(() => {
    running = null
    opening.end('opening')
  })

  return running
}

async function restoreChain () {
  const pass = ++begun

  // Whether every page had its hash as this pass began — see the move below.
  const whole = pages.value.every((entry) => !entry.scan || entry.scan.hash)

  await syncPages()

  // Outside `syncPages`, as in the web build: it does nothing for a reader who
  // may not amend the chapter, and showing the chapter is not an amendment.
  showMissing()

  await restoreBlocks()
  await restoreCached()

  // A local workspace's layer stacks, which nothing else keeps — see
  // `useLayerCache`.
  await restoreLayers()

  read.value = pass

  await restorePatches()

  // Desktop: a workspace from before the database, moved into it now that the
  // whole chapter is back on screen — see `useMoveIn`, which moves a workspace
  // once. Only after a pass that began with every page hashed, and with no
  // pass queued behind it: the reading comes back by hash, and a hash that
  // lands mid-pass is a page this pass skipped, whose reading the move would
  // then leave behind — it did, on the first test of this.
  if (whole && !again && looked.value && !shared.value) await moveIn()
}

/*
 * Run it as the pages arrive, as their hashes land — everything kept is filed
 * by hash, so a page without one has nothing to look up yet — as the record's
 * rows change (only what the chain reads from them, so a rename does not re-run
 * it), and whenever the chapter is opened again (`epoch`), which the counts
 * cannot see: reopening gives the same pages back as new objects with no blocks
 * on them. See the web build.
 */
watch(
  [
    () => pages.value.length,
    () => pages.value.filter((entry) => entry.scan?.hash).length,
    () => (shared.value
      ? `${shared.value.role}|${shared.value.workspace.name}|${shared.value.pages
        .map((row) => `${row.id}:${row.uid}:${row.hash}:${row.position}:${row.path}:${row.name}:${row.width}:${row.height}`)
        .join(',')}`
      : null),
    epoch,
  ],
  () => { settle() },
)

// The cleaner is half of every repair's name, so changing it looks them up again.
watch(() => [cleanSettings.value.model, cleanSettings.value.segmenter], () => { restorePatches() })

/*
 * The page on screen's cleaning, from its record of what it last showed — see
 * `useClean.showKept`. Kept as a promise, because `composing` below waits for
 * the page the reader lands on to have read its record.
 */
let kept: Promise<void> = Promise.resolve()

watch(() => [page.value?.id, page.value?.scan?.hash], () => { kept = showKept(page.value) }, { immediate: true })

/*
 * The page is shown whole, or not yet — the web build's `composing`, as there.
 *
 * On the way in the parts of a page arrive separately: the scan as soon as the
 * folder is read, the reading a moment later, the repairs from the record a
 * moment after the hash. Drawn as they came, the printed lettering showed on its
 * own for a few hundred milliseconds before the cleaning and the translation
 * covered it — every launch, on the page the reader comes back to.
 *
 * So the board stays hidden until the saved page has been turned to, one pass of
 * the chain above has put the reading back, and the page's record of its
 * repairs has been read and decoded, with the lettering's faces — or
 * `COMPOSE_MS` after the page mounted, whichever is first, so a slow disk costs
 * the reader a flash rather than a blank canvas. After that nothing is held
 * back: a page turned to is drawn as it comes.
 */
const COMPOSE_MS = 3000

const composing = ref(true)
const composeCap = setTimeout(() => { composing.value = false }, COMPOSE_MS)

watch(placing, async (stillPlacing) => {
  if (stillPlacing || !composing.value) return

  const wanted = begun + 1

  settle()

  // The page's own reading back is the usual answer, and arrives long before a
  // fresh pass can. The pass is for the page that has no blocks at all, which
  // only it can vouch for.
  //
  // Asked once before watching rather than with `immediate`: a page whose
  // reading is already there (one the database holds and this machine has no
  // file for, above all) answered inside the immediate call, and called `stop`
  // before `watch` had returned it — a ReferenceError, and the page held hidden
  // for the whole of `COMPOSE_MS`.
  await new Promise<void>((resolve) => {
    const waiting = () => !page.value?.blocks.length && read.value < wanted && composing.value

    if (!waiting()) return resolve()

    const stop = watch([read, composing, () => page.value?.blocks.length], () => {
      if (waiting()) return

      stop()
      resolve()
    })
  })

  if (!composing.value) return

  // Decoded as well as read: an image onto a blob that has only just been made
  // paints a frame or two after it is mounted.
  const decoded = kept.then(() => Promise.all(
    Object.values((page.value && shownRepairs.value[page.value.id]) ?? {}).map((repair) => {
      const image = new Image()

      image.src = repair.url

      return image.decode().catch(() => {})
    }),
  ))

  // And the lettering's faces, which started loading as the hidden board laid
  // the blocks out — see `faceReady` in the board.
  await Promise.race([Promise.all([decoded, document.fonts.ready]), new Promise((resolve) => setTimeout(resolve, 300))])

  composing.value = false
})

onBeforeUnmount(() => {
  clearTimeout(composeCap)
  // Lets a wait still in the air above give up rather than outlive the page.
  composing.value = false
})

/*
 * Once the first page is on screen, every other page is made ready to be turned
 * to: a preview of each at the size it is shown at, and its sketch, kept on disk
 * — see `utils/raster/previews.ts` for why disk and not memory. Nearest the page
 * on screen first, on a worker of its own, and never while a Clean run has the
 * machine. Started again, after a second's quiet, when pages gain hashes, the
 * room changes size or a page's cleaning changes; pages that already have one
 * are skipped at once. The web build's, as written.
 */
const route = useRoute()

let previewing: { stop: () => void } | null = null
let previewSoon: ReturnType<typeof setTimeout> | undefined

/** A page's repairs, placed — what its cleaning is made of (see `cleaningSignature`). */
const repairsOfPage = (target: ComicPage) => repairOvers(target, shownRepairs.value[target.id], patchStands)

watch(
  () => [
    composing.value,
    pages.value.map((target) => `${target.scan?.hash ?? ''}:${target.scan?.width ?? 0}`).join(','),
    room.value.w,
    room.value.h,
    pages.value.map((target) => cleaningSignature(repairsOfPage(target))).join(','),
  ] as const,
  ([still]) => {
    clearTimeout(previewSoon)
    previewing?.stop()
    previewing = null

    if (still) return

    previewSoon = setTimeout(() => {
      const from = at.value
      const dpr = window.devicePixelRatio || 1

      const list = pages.value
        .map((target, index) => ({ target, index }))
        .sort((a, b) => Math.abs(a.index - from) - Math.abs(b.index - from))
        .flatMap(({ target }) => {
          const scan = target.scan

          if (!scan?.hash || !scan.width || !scan.height) return []

          const own = { width: scan.width, height: scan.height }
          const fit = fitLevel(own, fittedHeight(room.value, own.width / own.height), dpr)

          return [{ url: scan.url, file: scan.file, hash: scan.hash, page: own, fit, repairs: repairsOfPage(target) }]
        })

      previewing = makePreviews(String(route.params.workspaceId ?? ''), list, () => cleaning.value)
    }, 1000)
  },
)

onBeforeUnmount(() => {
  clearTimeout(previewSoon)
  previewing?.stop()
})

/*
 * And the record kept up to date as that page's repairs change — a clean, a
 * brush correction, `restore` settling. Half a second after they stop, because
 * a page run shows its repairs a balloon at a time. Without it `showKept` above
 * had only what the web build had written before the move to the desktop — or
 * nothing.
 */
let keeping: ReturnType<typeof setTimeout> | null = null

watch(() => (page.value ? shownRepairs.value[page.value.id] : null), () => {
  if (keeping) clearTimeout(keeping)

  const target = page.value

  keeping = setTimeout(() => { keeping = null; keepShown(target) }, 500)
})

/*
 * Each page's size, told to the record once this window has measured it — see
 * `useShared.fill`. Once the burst of measurements has gone quiet, one request
 * for the lot; rows already sized cost nothing.
 */
let sizing: ReturnType<typeof setTimeout> | null = null

watch(() => pages.value.filter((entry) => entry.scan?.width).length, (sized) => {
  if (sizing) clearTimeout(sizing)
  if (!sized) return

  sizing = setTimeout(() => { sizing = null; fillPages() }, 1000)
})

onBeforeUnmount(() => {
  if (sizing) clearTimeout(sizing)
})

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

  return pending.value?.title ?? shared.value?.workspace.name ?? 'No comic open'
})

const dimensions = computed(() => {
  const scan = page.value?.scan

  if (!scan?.width || !scan?.height) return null

  return `${scan.width} × ${scan.height}`
})

const held = computed(() => {
  if (kind.value === 'handle') return 'In your folder'
  if (kind.value === 'copy') return 'Copied into this app'
  // Desktop: loose files and PDFs, read where they are — see `Source`.
  if (kind.value === 'sources') return 'In your files'

  return null
})

function scale (by: number) {
  zoomAt(by, undefined, true)
}

/** Blocks on the page still wanting a translation — for the status bar's tally. */
const untranslated = computed(() =>
  page.value?.blocks.filter((block) => block.type !== 'garbage' && !block.translation).length ?? 0,
)
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
      <template v-else>
        <CanvasBoard :class="{ invisible: placing || composing }" />

        <!--
          Over the chapter rather than instead of it: pages whose files are not
          here are still on screen and workable. See the component.
        -->
        <CanvasAbsent />
      </template>
    </CanvasDrop>

    <template #toolbar>
      <div class="flex min-w-0 items-center gap-2">
        <!-- Where you are, and the way to open something else here. -->
        <UButton variant="ghost" size="sm" class="min-w-0" @click="openFolder">
          <FolderOpenIcon class="size-4 flex-none" />
          <span class="truncate">{{ heading }}</span>
        </UButton>

        <!--
          What this workspace is — its name, how it reads, what is kept where.
          Beside the name rather than inside it: that button opens a folder.
        -->
        <WorkspaceSettings v-if="!restoring" />

        <div class="bg-border h-5 w-px flex-none" />

        <!--
          Undo and redo — the web build's buttons. Greyed when there is nothing
          to take back, which is the one way the app can say so before you
          press and wonder.
        -->
        <UButton
          variant="ghost"
          size="icon-sm"
          :disabled="!canUndo"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          @click="undo()"
        >
          <Undo2Icon class="size-4" />
        </UButton>
        <UButton
          variant="ghost"
          size="icon-sm"
          :disabled="!canRedo"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          @click="redo()"
        >
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

    <!-- what it can do to that -->
    <template #actions>
      <!--
        The pipeline end to end, first among the actions because it is the one
        that does what all the others are for — see `AutoRun`, which owns every
        decision about it including whether there is anything to run. The web
        build's people and sharing controls follow it there; the desktop app has
        neither, so only the rule before the title bar's own icons does.
      -->
      <AutoRun />

      <div class="bg-border h-6 w-px flex-none" />
    </template>

    <!-- the tool that is out, its settings, and what it is pointed at -->
    <template #context>
      <span class="text-foreground font-medium">{{ label }}</span>
      <ToolOptions />
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

        <!--
          The page's tally, as in the web build: how many blocks, and whether any
          still want a translation — only once there are blocks, or an unread page
          would read as finished. Guarded on the bar's own width, so it is the
          first thing to go when the docks squeeze it.
        -->
        <div class="bg-border mx-1 hidden h-4 w-px @xl:block" />
        <span class="hidden whitespace-nowrap @xl:inline">{{ page?.blocks.length ?? 0 }} blocks</span>
        <template v-if="page?.blocks.length">
          <span v-if="untranslated" class="hidden whitespace-nowrap text-amber-500 @xl:inline">{{ untranslated }} untranslated</span>
          <span v-else class="hidden whitespace-nowrap text-emerald-500 @xl:inline">all translated</span>
        </template>

        <!--
          Still opening, or opened and never cleaned — the two things a page with
          no cleaning on it could mean. See `WorkspaceOpening`.
        -->
        <WorkspaceOpening />
      </template>

      <div class="flex-1" />

      <!--
        What the models have cost on this page, and what the next press is
        expected to — the web build's pair, as there: `~` on the estimate, which
        is arithmetic over a prompt not yet sent, and `≥` on a total with
        unpriced calls in it, which is a floor rather than a bill.
      -->
      <template v-if="estimate || pageCost.calls">
        <span v-if="estimate" class="text-muted-foreground hidden font-mono whitespace-nowrap tabular-nums @4xl:inline">
          {{ estimate.force ? 'next · again' : 'next' }} ~${{ estimate.cost.toFixed(4) }}
        </span>
        <span v-if="estimate && pageCost.calls" class="bg-border hidden h-4 w-px @4xl:block" />
        <span v-if="pageCost.calls" class="hidden font-mono whitespace-nowrap tabular-nums @4xl:inline">
          page {{ pageCost.unpriced ? '≥' : '' }}${{ pageCost.cost.toFixed(4) }}
        </span>
        <div class="bg-border hidden h-4 w-px @4xl:block" />
      </template>

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
