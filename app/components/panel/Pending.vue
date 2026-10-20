<script setup lang="ts">
/**
 * A section whose panel has not been migrated from the web build yet. Says so,
 * rather than leaving the section empty, so a dock full of these reads as work
 * in progress and not as panels that failed to load.
 */
defineProps<{ label: string }>()
</script>

<template>
  <p class="text-muted-foreground text-xs">
    The {{ label }} panel has not been migrated yet.
  </p>
</template>
