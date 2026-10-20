<script setup lang="ts">
/**
 * The app's own title bar. The window has none (`titleBarStyle: 'hidden'`, see
 * `electron/main.ts`), so this strip is the caption: it is a drag region, and
 * everything interactive inside it opts out with `no-drag` — a button left in
 * the drag region does not receive clicks at all.
 *
 * Window controls are drawn on Windows and Linux only. On macOS the system's
 * traffic lights stay, and the bar leaves room for them unless the window is
 * full screen, where they are hidden.
 *
 * Opened outside Electron (the dev server in a plain browser) there is no
 * `window.kemolate`, and the bar is just a bar.
 */
import type { WindowState } from '../../electron/preload'

import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string }>()

const api = window.kemolate
const mac = api?.platform === 'darwin'
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
  <header
    class="flex h-9 shrink-0 items-center border-b border-line bg-chrome text-sm select-none [-webkit-app-region:drag]"
    :class="state.focused ? 'text-fg' : 'text-muted'"
  >
    <div v-if="mac && !state.fullScreen" class="w-19 shrink-0" />

    <div class="flex items-center gap-2 px-3">
      <svg class="size-4 text-accent" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M5 4.5v7M5 8l5-3.5M6.5 7l4 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span class="font-medium">{{ title }}</span>
    </div>

    <!-- Menus and the workspace's name go here; anything clickable must be no-drag. -->
    <div class="flex h-full items-center [-webkit-app-region:no-drag]">
      <slot />
    </div>

    <div class="flex-1" />

    <div v-if="api && !mac" class="flex h-full [-webkit-app-region:no-drag]">
      <button
        type="button"
        class="grid h-full w-11.5 place-items-center hover:bg-hover"
        aria-label="Minimise"
        title="Minimise"
        @click="api.window.minimize()"
      >
        <svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="grid h-full w-11.5 place-items-center hover:bg-hover"
        :aria-label="state.maximized ? 'Restore' : 'Maximise'"
        :title="state.maximized ? 'Restore' : 'Maximise'"
        @click="api.window.toggleMaximize()"
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
        @click="api.window.close()"
      >
        <svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  </header>
</template>
