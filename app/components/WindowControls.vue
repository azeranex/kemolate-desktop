<script setup lang="ts">
/**
 * Minimise, maximise and close, for Windows and Linux — drawn by the page
 * because the window has no title bar of its own. The full height of whatever
 * row holds them, so the corner is the close button the way the system's own
 * is: the title bar, or the tab strip above it once there are two tabs. Moved
 * out of `TitleBar` so either row can hold them.
 */
import type { WindowState } from '../../electron/preload'

defineProps<{ state: WindowState }>()

const api = window.kemolate
</script>

<template>
  <div class="ml-1 flex h-full flex-none" :class="!state.focused && 'text-muted-foreground'">
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
</template>
