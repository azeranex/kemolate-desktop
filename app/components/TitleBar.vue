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
 * full height of the bar so the corner is the close button the way the system's
 * own is. macOS: the system's traffic lights stay, at the left, centred in this
 * bar by `trafficLightPosition`; the bar leaves them their room unless the
 * window is full screen, where macOS hides them.
 *
 * Opened outside Electron — the dev server in a plain browser — there is no
 * `window.kemolate`, and the bar is the web build's header and nothing more.
 *
 * ## Not here (yet)
 *
 * The account menu: the desktop app has no accounts. And the mark is not a link
 * yet — in the web build it went to the collection of workspaces, which has not
 * been migrated.
 */
import type { WindowState } from '../../electron/preload'

const api = window.kemolate
const mac = api?.platform === 'darwin'
const controls = Boolean(api) && !mac
const state = ref<WindowState>({ maximized: false, fullScreen: false, focused: true })

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
  <!--
    `gap-2` and nothing else spaces this row, as in the web build: one value on
    the row and the same value inside the slots, so every neighbour is 8px from
    the next whatever wrapper it is in.

    The padding is the one place the window shows through. On macOS the left
    edge belongs to the traffic lights; on Windows the right edge belongs to the
    window controls, which sit flush against it as the system's would.
  -->
  <header
    class="app-titlebar border-border bg-card @container flex h-14 flex-none items-center gap-2 overflow-hidden border-b whitespace-nowrap select-none [-webkit-app-region:drag]"
    :class="[
      mac && !state.fullScreen ? 'pl-21' : 'pl-3',
      controls ? 'pr-0' : 'pr-3',
    ]"
  >
    <!-- The mark. -->
    <Logo :size="32" class="flex-none" />

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

    <div v-if="controls" class="ml-1 flex h-full flex-none" :class="!state.focused && 'text-muted-foreground'">
      <button
        type="button"
        class="hover:bg-muted grid h-full w-11.5 place-items-center"
        aria-label="Minimise"
        title="Minimise"
        @click="api!.window.minimize()"
      >
        <svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="hover:bg-muted grid h-full w-11.5 place-items-center"
        :aria-label="state.maximized ? 'Restore' : 'Maximise'"
        :title="state.maximized ? 'Restore' : 'Maximise'"
        @click="api!.window.toggleMaximize()"
      >
        <svg v-if="state.maximized" class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" />
        </svg>
        <svg v-else class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="grid h-full w-11.5 place-items-center hover:bg-[#c42b1c] hover:text-white"
        aria-label="Close"
        title="Close"
        @click="api!.window.close()"
      >
        <svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  </header>
</template>
