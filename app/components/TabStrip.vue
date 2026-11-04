<script setup lang="ts">
/**
 * The window's tabs, in a row above the title bar — always, one tab or many
 * (see `TitleBar`). Each tab is a page of its own (`electron/tabs.ts`), and
 * every one draws this same strip from the list the main process says
 * (`useTabs`). The last tab has no cross: closing it is closing the window,
 * which the window's own button does.
 *
 * A browser's strip, kept to what a browser's does: click to show, the cross
 * or a middle click to close, the plus for a new one, a right click for the
 * tab's menu (`Tabs.menu`, native). The row is part of the
 * caption — it drags the window, as the title bar does — and the tabs and
 * buttons in it are excluded from that by `.app-titlebar`'s rule, so it sits
 * inside a `TitleBar`.
 */
import { BookImageIcon, LibraryBigIcon, PlusIcon, XIcon } from '@lucide/vue'

const { state, select, close, open, menu } = useTabs()

const mod = window.kemolate?.platform === 'darwin' ? '⌘' : 'Ctrl+'
</script>

<template>
  <div class="flex min-w-0 flex-1 items-end gap-1 self-stretch pt-1.5" role="tablist" aria-label="Tabs">
    <button
      v-for="(tab, at) in state.tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="tab.id === state.active"
      :title="at < 8 ? `${tab.title} (${mod}${at + 1})` : tab.title"
      class="group flex h-full max-w-56 min-w-24 flex-1 basis-0 items-center gap-1.5 rounded-t-md border border-b-0 pr-1 pl-2.5 text-left text-xs"
      :class="tab.id === state.active
        ? 'bg-card from-primary/15 to-card to-50% border-border text-foreground bg-linear-to-b shadow-[inset_0_2px_0_var(--primary)]'
        : 'text-muted-foreground hover:bg-card/60 hover:text-foreground border-transparent'"
      @click="select(tab.id)"
      @auxclick.prevent="(event: MouseEvent) => { if (event.button === 1) close(tab.id) }"
      @contextmenu.prevent="(event: MouseEvent) => menu(tab.id, event)"
    >
      <!-- What the tab is showing: a chapter, as the list draws one without a thumbnail, or the list. -->
      <BookImageIcon v-if="tab.workspace" class="size-3.5 flex-none" aria-hidden="true" />
      <LibraryBigIcon v-else class="size-3.5 flex-none" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ tab.title }}</span>
      <span
        v-if="state.tabs.length > 1"
        role="button"
        :aria-label="`Close ${tab.title}`"
        :title="`Close (${mod}W)`"
        class="hover:bg-muted grid size-5 flex-none place-items-center rounded-sm opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100"
        @click.stop="close(tab.id)"
      >
        <XIcon class="size-3" />
      </span>
    </button>

    <button
      type="button"
      :aria-label="`New tab (${mod}T)`"
      :title="`New tab (${mod}T)`"
      class="text-muted-foreground hover:bg-card/60 hover:text-foreground mb-1 grid size-6 flex-none place-items-center self-center rounded-md"
      @click="open()"
    >
      <PlusIcon class="size-3.5" />
    </button>
  </div>
</template>
