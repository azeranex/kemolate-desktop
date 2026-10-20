<script setup lang="ts">
/**
 * File, Edit and View — the app's actions where a desktop program keeps them.
 *
 * Almost nothing here is new; it is where things are *found*. Opening lived on
 * the chapter's name, the project file in the workspace settings, undo on two
 * icons, zoom in the status bar, the presets in the Layers panel — each fine
 * where it is, and each invisible until you knew. The menus gather them under
 * the three words every reader already looks for, and the buttons stay where
 * they were for the reader who already knows.
 *
 * Two things are new, and both are File's: opening loose files rather than a
 * folder (`useLibrary.openFiles`), and exporting finished pages
 * (`usePageExport`). "Export" repeats this workspace's last export without
 * asking; "Export as…" asks. Like Save against Save as.
 *
 * A shortcut is shown only where one really is bound. A menu promising a key
 * that does nothing is a small lie told every time it is opened.
 *
 * Every plain item carries an icon — the same one the app uses for that action
 * elsewhere where there is one (the folder, the project box, the bin) — and
 * the check and radio items do not: their slot is where the tick or the dot
 * goes, and the icon's width is what lines every label up with theirs.
 */
import {
  DownloadIcon,
  FileOutputIcon,
  FilesIcon,
  FolderOpenIcon,
  FullscreenIcon,
  PackageOpenIcon,
  Redo2Icon,
  SaveIcon,
  SquareDashedMousePointerIcon,
  Trash2Icon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from '@lucide/vue'

/*
 * ## Stand-ins, until what the menus drive is migrated
 *
 * In the web build these come from `useComic`, `useLibrary`, `useProjectFile`,
 * `useUndo`, `useLayerPresets`, `usePageExport` and `useBalloonDebug`, none of
 * which has come across yet. Each line below stands in for one of them, shaped
 * so the template — which is the web build's, unchanged — reads it truthfully:
 * no pages, nothing selected, nothing to undo, no export run. So every item that
 * needs a chapter is disabled by its own condition, exactly as it is in the web
 * build with nothing open.
 *
 * The three Open items have no condition — they are how a chapter *gets* open —
 * so theirs say, when pressed, that they have not arrived, rather than doing
 * nothing. As each composable lands, its stand-in goes and its line comes back:
 *
 *   const { pages, selection, selectAll, removeBlock, zoomAt, resetView } = useComic()
 *   const { openFolder, openFiles } = useLibrary()
 *   const { busy: packing, save } = useProjectFile()
 *   const { undo, redo, canUndo, canRedo } = useUndo()
 *   const { presets, active, apply, writable } = useLayerPresets()
 *   const { last, recall, run, running } = usePageExport()
 *   const { on: balloonDebug } = useBalloonDebug()
 *
 * and with them the `<ProjectImport>` and `<ExportDialog>` at the foot of the
 * template, and the watch on the route that recalls this workspace's last export.
 */
function notYet (what: string) {
  return () => { toast.info(`${what} has not been migrated to the desktop app yet.`) }
}

const pages = ref<unknown[]>([])
const selection = ref<string[]>([])
const selectAll = () => {}
const removeBlock = (_id: string) => {}
const zoomAt = (..._args: unknown[]) => {}
const resetView = () => {}
const openFolder = notYet('Opening a folder')
const openFiles = notYet('Opening files')
const packing = ref(false)
const save = () => {}
const undo = () => {}
const redo = () => {}
const canUndo = ref(false)
const canRedo = ref(false)
// The four presets by their real ids and names (`LAYER_PRESETS`), greyed as for
// a reader who may not write them.
const presets = [
  { id: 'read', label: 'Read' },
  { id: 'clean', label: 'Clean' },
  { id: 'letter', label: 'Letter' },
  { id: 'final', label: 'Final' },
]
const active = ref<string | null>(null)
const apply = (_id: string) => {}
const writable = ref(false)
const last = ref<{ format: 'pdf' | 'png' | 'jpeg', range?: { from: number, to: number } } | null>(null)
const run = (_options: unknown) => {}
const running = ref(false)
const balloonDebug = ref(false)

const importer = ref<{ choose: () => void } | null>({ choose: notYet('Opening a project') })
const exporting = ref(false)

/** ⌘ where it is ⌘, Ctrl elsewhere — as the bindings themselves decide. */
const mod = window.kemolate?.platform === 'darwin' ? '⌘' : 'Ctrl+'

/** The last export, in a few words, so "Export" says what it will do. */
const lastSaid = computed(() => {
  const kept = last.value

  if (!kept) return null

  const what = kept.format === 'pdf' ? 'PDF' : kept.format === 'png' ? 'PNG' : 'JPEG'
  const which = kept.range ? `pages ${kept.range.from}–${kept.range.to}` : 'all pages'

  return `${what}, ${which}`
})

function exportAgain () {
  if (last.value) run(last.value)
  else exporting.value = true
}

function deleteSelection () {
  // A copy, because `removeBlock` prunes the selection as it goes.
  for (const id of [...selection.value]) removeBlock(id)
}
</script>

<template>
  <UMenubar class="h-8 border-none bg-transparent p-0 shadow-none">
    <UMenubarMenu>
      <UMenubarTrigger class="px-2 py-1 text-sm">
        File
      </UMenubarTrigger>
      <UMenubarContent align="start" class="min-w-56">
        <UMenubarItem @select="openFolder">
          <FolderOpenIcon /> Open folder…
        </UMenubarItem>
        <UMenubarItem @select="openFiles">
          <FilesIcon /> Open files…
        </UMenubarItem>
        <UMenubarItem @select="importer?.choose()">
          <PackageOpenIcon /> Open project…
        </UMenubarItem>
        <UMenubarSeparator />
        <UMenubarItem :disabled="!pages.length || Boolean(packing)" @select="save">
          <SaveIcon /> Save project as…
        </UMenubarItem>
        <UMenubarSeparator />
        <UMenubarItem :disabled="!pages.length || running" @select="exportAgain">
          <DownloadIcon /> Export
          <UMenubarShortcut v-if="lastSaid" class="tracking-normal">
            {{ lastSaid }}
          </UMenubarShortcut>
        </UMenubarItem>
        <UMenubarItem :disabled="!pages.length || running" @select="exporting = true">
          <FileOutputIcon /> Export as…
        </UMenubarItem>
      </UMenubarContent>
    </UMenubarMenu>

    <UMenubarMenu>
      <UMenubarTrigger class="px-2 py-1 text-sm">
        Edit
      </UMenubarTrigger>
      <UMenubarContent align="start" class="min-w-52">
        <UMenubarItem :disabled="!canUndo" @select="undo()">
          <Undo2Icon /> Undo <UMenubarShortcut>{{ mod }}Z</UMenubarShortcut>
        </UMenubarItem>
        <UMenubarItem :disabled="!canRedo" @select="redo()">
          <Redo2Icon /> Redo <UMenubarShortcut>⇧{{ mod }}Z</UMenubarShortcut>
        </UMenubarItem>
        <UMenubarSeparator />
        <UMenubarItem :disabled="!pages.length" @select="selectAll()">
          <SquareDashedMousePointerIcon /> Select all blocks <UMenubarShortcut>{{ mod }}A</UMenubarShortcut>
        </UMenubarItem>
        <UMenubarItem :disabled="!selection.length" @select="deleteSelection">
          <Trash2Icon /> Delete selected <UMenubarShortcut>⌫</UMenubarShortcut>
        </UMenubarItem>
      </UMenubarContent>
    </UMenubarMenu>

    <UMenubarMenu>
      <UMenubarTrigger class="px-2 py-1 text-sm">
        View
      </UMenubarTrigger>
      <UMenubarContent align="start" class="min-w-52">
        <UMenubarItem :disabled="!pages.length" @select="zoomAt(1.25, undefined, true)">
          <ZoomInIcon /> Zoom in
        </UMenubarItem>
        <UMenubarItem :disabled="!pages.length" @select="zoomAt(1 / 1.25, undefined, true)">
          <ZoomOutIcon /> Zoom out
        </UMenubarItem>
        <UMenubarItem :disabled="!pages.length" @select="resetView()">
          <FullscreenIcon /> Fit page <UMenubarShortcut>0</UMenubarShortcut>
        </UMenubarItem>
        <!--
          Each block's Reading box, room and hand-placed frame, and which one its
          lettering is in — see `useBalloonDebug`.
        -->
        <UMenubarCheckboxItem v-model="balloonDebug" :disabled="!pages.length">
          Balloon debug
        </UMenubarCheckboxItem>
        <UMenubarSeparator />
        <!--
          The presets write every page's standard rows, so they are an editor's
          — see `useLayerPresets`. Shown to everybody, greyed where not theirs,
          so the menu reads the same whoever opens it.
        -->
        <UMenubarRadioGroup :model-value="active ?? ''">
          <UMenubarRadioItem
            v-for="preset in presets"
            :key="preset.id"
            :value="preset.id"
            :disabled="!writable"
            @select="apply(preset.id)"
          >
            {{ preset.label }} layers
          </UMenubarRadioItem>
        </UMenubarRadioGroup>
      </UMenubarContent>
    </UMenubarMenu>
  </UMenubar>

  <!-- `<ProjectImport ref="importer" />` and `<ExportDialog v-model:open="exporting" />` return with their composables. -->
</template>
