<script setup lang="ts">
/**
 * Nuxt's `<NuxtLink>`, as far as the desktop app needs it — so a ported
 * template that links somewhere stays as written.
 *
 * An anchor carrying the address, which keeps what a link is for the keyboard
 * and the accessibility tree, and a click that goes there through `navigateTo`
 * (the in-memory route in `composables/nuxt.ts`) rather than letting the window
 * load a page. A modified click is let through to nothing — there are no other
 * windows or tabs to open it in — rather than handed to the browser, which would
 * try to leave the app.
 */
const props = defineProps<{ to: string }>()

function go (event: MouseEvent) {
  event.preventDefault()

  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  void navigateTo(props.to)
}
</script>

<template>
  <a :href="to" @click="go"><slot /></a>
</template>
