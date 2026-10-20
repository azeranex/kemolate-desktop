<script setup lang="ts">
/**
 * The app's root: whichever page the route is at, and what belongs to the app
 * rather than to any page — the toaster, as in the web build's `app.vue`.
 *
 * Three places to be, as `composables/nuxt.ts` describes: a workspace
 * (`/w/<id>`, the web build's `pages/w/[workspaceId].vue`), Settings
 * (`/settings`), and the collection of workspaces (`/`). The collection page has
 * not been migrated, so at `/` the app does what it would have been asked to do
 * there: go back to the workspace that was open, or else open the one used most
 * recently, or make a new one — the web build's "New workspace", which is a
 * fresh id and nothing more until a chapter is opened in it.
 *
 * ## Settings is drawn over the workspace, not instead of it
 *
 * In the web build moving to `/settings` unmounts the workspace page, and coming
 * back mounts it again — which reopens the chapter: the folder asked for again,
 * every page identified, the readings and repairs restored. In a browser that is
 * what a page load costs anyway. In a window that never reloads it is seconds
 * spent for having looked at a setting. So the workspace page stays mounted,
 * hidden, while Settings is shown, and coming back is just showing it again.
 *
 * The workspace page is keyed on its workspace, as the web build's
 * `definePageMeta({ key })` keys it on the route, so moving to *another*
 * workspace still mounts its page afresh.
 */
import WorkspacePage from './pages/w/[workspaceId].vue'
import SettingsPage from './pages/settings.vue'

useHead({ title: 'Kemolate' })

const route = useRoute()
const { latest, create } = useWorkspaces()

/** The workspace last shown — kept while Settings is up, so it can stay mounted behind it. */
const workspace = ref<string | null>(null)

watch(() => route.params.workspaceId, (id) => {
  if (id) workspace.value = id
}, { immediate: true })

watch(() => route.path, async (path) => {
  if (path !== '/') return

  await navigateTo(`/w/${workspace.value ?? (await latest()) ?? create()}`)
}, { immediate: true })

const settings = computed(() => route.path === '/settings')

/**
 * Which palette the toasts are drawn from — see the web build's `app.vue`:
 * sonner keeps its own idea of light and dark, and left alone handed out the
 * light rich colours over a dark app.
 */
const { resolved } = useColorScheme()
</script>

<template>
  <WorkspacePage v-if="workspace" v-show="!settings" :key="workspace" />

  <SettingsPage v-if="settings" />

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
