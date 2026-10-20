<script setup lang="ts">
import TitleBar from './components/TitleBar.vue'

const platform = window.kemolate?.platform ?? 'browser'
</script>

<template>
  <div class="flex h-screen flex-col bg-canvas text-fg">
    <TitleBar title="Kemolate" />
    <main class="grid flex-1 place-items-center">
      <div class="max-w-md space-y-2 text-center">
        <h1 class="text-lg font-semibold">
          Kemolate Desktop
        </h1>
        <p class="text-sm text-muted">
          The shell is running on <span class="font-mono text-fg">{{ platform }}</span>.
          No chapter yet — this is where the workspace will open.
        </p>
      </div>
    </main>
  </div>
</template>
