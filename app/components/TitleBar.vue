<script setup lang="ts">
/**
 * The window's title bar, which is the web build's workspace header: the mark,
 * what the page is working on (`toolbar`), what it can do to that (`actions`),
 * and at the far edge what has been said and how it looks. Migrated from
 * `layouts/workspace.vue`'s brand bar, so the desktop app wears the same
 * header — with the window's own controls added, because the window has no
 * title bar of its own (`titleBarStyle: 'hidden'`, see `electron/main.ts`).
 *
 * ## Being the caption
 *
 * The whole bar is a drag region: drag to move, double-click to maximise, drag
 * to an edge to snap. Anything interactive inside it is excluded by one rule in
 * `tailwind.css` (`.app-titlebar`), rather than by each control remembering —
 * a button left in a drag region does not receive clicks at all, and the
 * toolbar slot is filled by pages that know nothing about windows.
 *
 * ## Window controls
 *
 * Windows and Linux: minimise, maximise and close, drawn here at the right, the
 * full height of the top row so the corner is the close button the way the
 * system's own is (`WindowControls`). macOS: the system's traffic lights stay,
 * at the left, centred in the top row by the main process; that row leaves them
 * their room unless the window is full screen, where macOS hides them.
 *
 * ## Tabs
 *
 * In the app the strip (`TabStrip`) is a row of its own above the bar, one tab
 * or many, and the top row is the strip: the window controls and the traffic
 * lights are in it, as a browser keeps them. It was drawn only from two tabs on
 * and asked for always (2026-11-04): a strip that comes and goes moves the whole
 * app down and up as a second chapter is opened and closed.
 *
 * Opened outside Electron — the dev server in a plain browser — there is no
 * `window.kemolate`, and the bar is the web build's header and nothing more.
 *
 * ## Not here
 *
 * The account menu: the desktop app has no accounts.
 */
import type { WindowState } from '../../electron/preload'

const api = window.kemolate
const mac = api?.platform === 'darwin'
const controls = Boolean(api) && !mac
const state = ref<WindowState>({ maximized: false, fullScreen: false, focused: true })

const { tabbed: strip } = useTabs()

/** Whether the macOS traffic lights sit at the left of the top row, which then leaves them room. */
const lights = computed(() => mac && !state.value.fullScreen)

let unsubscribe: (() => void) | undefined

onMounted(async () => {
  if (!api) return
  state.value = await api.window.state()
  unsubscribe = api.window.onState((next) => {
    state.value = next
  })
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="app-titlebar flex flex-none flex-col select-none">
    <!-- The tabs, once there are two — and then the window's own corner. -->
    <div
      v-if="strip"
      class="app-rail bg-muted flex h-10 flex-none items-stretch gap-2 overflow-hidden [-webkit-app-region:drag]"
      :class="[lights ? 'pl-21' : 'pl-2', controls ? 'pr-0' : 'pr-3']"
    >
      <TabStrip />
      <WindowControls v-if="controls" :state="state" />
    </div>

    <!--
      `gap-2` and nothing else spaces this row, as in the web build: one value on
      the row and the same value inside the slots, so every neighbour is 8px from
      the next whatever wrapper it is in.

      The padding is the one place the window shows through. On macOS the left
      edge belongs to the traffic lights; on Windows the right edge belongs to the
      window controls, which sit flush against it as the system's would — unless
      the strip above has taken both.
    -->
    <header
      class="border-border bg-card @container flex h-14 flex-none items-center gap-2 overflow-hidden border-b whitespace-nowrap [-webkit-app-region:drag]"
      :class="[
        lights && !strip ? 'pl-21' : 'pl-3',
        controls && !strip ? 'pr-0' : 'pr-3',
      ]"
    >
      <!-- The mark, which goes to the list of workspaces — as in the web build. -->
      <NuxtLink to="/" aria-label="Workspaces" title="Workspaces" class="flex-none">
        <Logo :size="32" />
      </NuxtLink>

      <!--
        File, Edit and View, beside the mark — where a desktop program keeps its
        menus. In the web build they sat inside the page's toolbar, behind a
        chevron that made the mark the root of a breadcrumb; here the menus are
        the app's own rather than the page's, so they are part of the bar, and the
        chevron went with the breadcrumb reading. See `AppMenu`.
      -->
      <AppMenu />

      <!-- What the page is working on: where you are, undo, pagination … -->
      <slot name="toolbar" />

      <div class="min-w-2 flex-1" />

      <!-- what it can do to that: run, export, settings … -->
      <slot name="actions" />

      <!-- what has been said, and how it looks, at the far edge -->
      <Notifications />
      <ColorScheme />

      <WindowControls v-if="controls && !strip" :state="state" />
    </header>
  </div>
</template>
