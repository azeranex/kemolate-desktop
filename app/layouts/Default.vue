<script setup lang="ts">
/**
 * The plain shell: the same brand bar the workspace wears, and the page under
 * it — the web build's `layouts/default.vue`.
 *
 * Desktop: the bar is `TitleBar`, the window's caption, which is the web build's
 * brand bar plus the window's controls and the menus; the account menu it ended
 * with is not here, since the desktop app has no accounts.
 *
 * The page scrolls under a bar that stays put — the page is a document, and the
 * bar is the window's caption, which must never scroll away.
 */
</script>

<template>
  <div class="bg-background text-foreground flex h-svh flex-col">
    <TitleBar />

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <slot />
    </div>
  </div>
</template>
