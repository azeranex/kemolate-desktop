<script setup lang="ts">
/**
 * The app's root: whichever page the route is at, and what belongs to the app
 * rather than to any page — the toaster, as in the web build's `app.vue`.
 *
 * Three places to be, as `composables/nuxt.ts` describes: the collection of
 * workspaces (`/`, the web build's `pages/index.vue`), one workspace (`/w/<id>`,
 * its `pages/w/[workspaceId].vue`), and Settings (`/settings`).
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
 * as in the web build, and a chapter chosen there is mounted afresh.
 *
 * The workspace page is keyed on its workspace, as the web build's
 * `definePageMeta({ key })` keys it on the route, so moving to *another*
 * workspace mounts its page afresh — and `useWorkspaceReset` lets go of the
 * last one's state.
 */
import CollectionPage from './pages/index.vue'
import WorkspacePage from './pages/w/[workspaceId].vue'
import SettingsPage from './pages/settings.vue'

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

onMounted(async () => {
  if (route.path === '/') {
    const last = await latest().catch(() => null)

    if (last) await navigateTo(`/w/${last}`)
  }

  arrived.value = true
})

const settings = computed(() => route.path === '/settings')

/**
 * Which palette the toasts are drawn from — see the web build's `app.vue`:
 * sonner keeps its own idea of light and dark, and left alone handed out the
 * light rich colours over a dark app.
 */
const { resolved } = useColorScheme()
</script>

<template>
  <template v-if="arrived">
    <WorkspacePage v-if="workspace" v-show="!settings" :key="workspace" />

    <CollectionPage v-else-if="!settings" />

    <SettingsPage v-if="settings" />
  </template>

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
