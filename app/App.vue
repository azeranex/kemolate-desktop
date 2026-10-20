<script setup lang="ts">
/**
 * The app's root: whichever page the route is at, and what belongs to the app
 * rather than to any page — the toaster, as in the web build's `app.vue`.
 *
 * Two places to be, as `composables/nuxt.ts` describes: a workspace (`/w/<id>`,
 * the web build's `pages/w/[workspaceId].vue`), and the collection of them
 * (`/`). The collection page has not been migrated, so at `/` the app does what
 * it would have been asked to do there: open the workspace used most recently,
 * or make a new one — the web build's "New workspace", which is a fresh id and
 * nothing more until a chapter is opened in it.
 *
 * The page is keyed on the route, as the web build's `definePageMeta({ key })`
 * keys it, so moving to another workspace mounts its page afresh.
 */
import WorkspacePage from './pages/w/[workspaceId].vue'

useHead({ title: 'Kemolate' })

const route = useRoute()
const { latest, create } = useWorkspaces()

watch(() => route.path, async (path) => {
  if (path !== '/') return

  await navigateTo(`/w/${(await latest()) ?? create()}`)
}, { immediate: true })

/**
 * Which palette the toasts are drawn from — see the web build's `app.vue`:
 * sonner keeps its own idea of light and dark, and left alone handed out the
 * light rich colours over a dark app.
 */
const { resolved } = useColorScheme()
</script>

<template>
  <WorkspacePage v-if="route.params.workspaceId" :key="route.fullPath" />

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
