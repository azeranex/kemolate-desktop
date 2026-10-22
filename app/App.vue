<script setup lang="ts">
/**
 * The app's root: whichever page the route is at, and what belongs to the app
 * rather than to any page — the toaster, as in the web build's `app.vue`.
 *
 * Four places to be, as `composables/nuxt.ts` describes: the collection of
 * workspaces (`/`, the web build's `pages/index.vue`), one workspace (`/w/<id>`,
 * its `pages/w/[workspaceId].vue`), Settings (`/settings`), and the OCR lab
 * (`/ocr-lab`, its `pages/ocr-lab.vue`, inside `LabWindow`).
 *
 * ## Where a launch lands
 *
 * In the last workspace opened, rather than in the list — a desktop program
 * comes back to the document you had open, and the list is a press of the mark
 * away. Only on the way in: `/` afterwards is the list, which is how another
 * chapter is reached or a new one started. A first launch with nothing to come
 * back to lands in the list, whose empty state says what to do.
 *
 * ## Settings is drawn over the workspace, not instead of it
 *
 * In the web build moving to `/settings` unmounts the workspace page, and coming
 * back mounts it again — which reopens the chapter: the folder asked for again,
 * every page identified, the readings and repairs restored. In a browser that is
 * what a page load costs anyway. In a window that never reloads it is seconds
 * spent for having looked at a setting. So the workspace page stays mounted,
 * hidden, while Settings is shown, and coming back is just showing it again.
 * The list is not drawn over it: leaving for the list is leaving the chapter,
 * as in the web build, and a chapter chosen there is mounted afresh. The OCR lab
 * is drawn over it the same way.
 *
 * The workspace page is keyed on its workspace, as the web build's
 * `definePageMeta({ key })` keys it on the route, so moving to *another*
 * workspace mounts its page afresh — and `useWorkspaceReset` lets go of the
 * last one's state.
 */
import CollectionPage from './pages/index.vue'
import SettingsPage from './pages/settings.vue'
import WorkspacePage from './pages/w/[workspaceId].vue'

useHead({ title: 'Kemolate' })

const route = useRoute()
const { latest } = useWorkspaces()

/** The workspace on screen, or behind Settings. Null in the list. */
const workspace = ref<string | null>(null)

watch(() => [route.path, route.params.workspaceId] as const, ([path, id]) => {
  if (id) workspace.value = id
  else if (path === '/') workspace.value = null
}, { immediate: true })

/** Whether the app has decided where a launch lands — see the header. */
const arrived = ref(false)

/*
 * A project file the operating system handed over — double-clicked, or named
 * on the command line — opens in a workspace of its own, ahead of the last
 * workspace a launch would otherwise land in. See `useOpenedFiles`.
 */
const { openWaiting, listen } = useOpenedFiles()

onBeforeUnmount(listen())

/**
 * The workspace a launch lands in: the last one this window opened, or — where
 * the window's own storage has no record of one, which is what losing it looks
 * like — the one most recently changed in the database. Null for none.
 */
async function landing (): Promise<string | null> {
  const last = await latest().catch(() => null)

  if (last) return last

  const kept = await $fetch<{ publicId: string }[]>('/api/workspaces').catch(() => [])

  return kept[0]?.publicId ?? null
}

/**
 * What opening the database found, said once — see `electron/database.ts`. A
 * damaged file is moved aside and the newest backup put in its place, and that
 * must never happen without a word: the reader's last hour or so of work may
 * be in the file that was set aside.
 */
async function sayHowDataOpened () {
  const notice = await window.kemolate?.data.notice().catch(() => null)

  if (!notice) return

  if (notice.chosen && notice.restoredFrom) {
    toast.success('Backup restored', { description: 'Every workspace’s work is as it was in that backup.' })
  } else if (notice.quarantined && notice.restoredFrom) {
    toast.warning('Kemolate’s database was damaged, and a backup was put back', {
      duration: Infinity,
      description: `Work done since the backup may be missing. The damaged file was kept, as ${notice.quarantined}, in the app’s data folder.`,
    })
  } else if (notice.quarantined) {
    toast.error('Kemolate’s database was damaged, and there was no backup to put back', {
      duration: Infinity,
      description: `A new one was started. The damaged file was kept, as ${notice.quarantined}, in the app’s data folder.`,
    })
  }
}

// The app's own updates: heard from the main process, and offered when one is ready — see `useUpdates`.
const { listen: hearUpdates } = useUpdates()

onMounted(async () => {
  sayHowDataOpened()
  hearUpdates()

  const handed = await openWaiting().catch(() => false)

  if (!handed && route.path === '/') {
    const last = await landing()

    if (last) await navigateTo(`/w/${last}`)
  }

  arrived.value = true
})

const settings = computed(() => route.path === '/settings')
const lab = computed(() => route.path === '/ocr-lab')

/**
 * Which palette the toasts are drawn from — see the web build's `app.vue`:
 * sonner keeps its own idea of light and dark, and left alone handed out the
 * light rich colours over a dark app.
 */
const { resolved } = useColorScheme()
</script>

<template>
  <template v-if="arrived">
    <!--
      Hidden by a wrapper, not on the page: the layout's root is reka's
      TooltipProvider, which renders only its slot — a fragment, which `v-show`
      cannot hide. On the page itself it did nothing, and Settings was drawn
      under the whole workspace rather than in place of it.
    -->
    <div v-if="workspace" v-show="!settings && !lab">
      <WorkspacePage :key="workspace" />
    </div>

    <CollectionPage v-else-if="!settings && !lab" />

    <SettingsPage v-if="settings" />

    <LabWindow v-if="lab" />
  </template>

  <!--
    Here for the same reason as the toaster, as in the web build: the question
    belongs to a file being read, not to whatever page it was dropped on.
  -->
  <PdfPassword />

  <!-- Desktop: and the question a big folder is asked before it is read — see `useFolderCheck`. -->
  <FolderCheck />

  <!--
    Mounted once, at the root, because a toast outlives whatever raised it.
    Wider than the default: these say what went wrong and what to do about it.
  -->
  <UToaster
    position="bottom-center"
    rich-colors
    close-button
    :theme="resolved"
    :duration="5000"
    :style="{ '--width': '26rem' }"
  />
</template>
