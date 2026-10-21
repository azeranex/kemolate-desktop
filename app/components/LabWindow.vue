<script setup lang="ts">
/**
 * The OCR lab (`pages/ocr-lab.vue`) as the desktop app shows it. Desktop only.
 *
 * In the web build the lab is a page of its own with no layout at all — a URL
 * somebody types, and the browser's own chrome around it for a way out. Here
 * there is no address bar and no window frame (`titleBarStyle: 'hidden'`), so a
 * page with no layout would be a window that cannot be moved, closed or left.
 * This gives it the window's title bar, a way back, and nothing else: the page
 * itself is the web build's, verbatim.
 *
 * Drawn over the workspace, as Settings is and for the same reason — see
 * `App.vue`: leaving the lab is showing the chapter again, not reopening it. And
 * guarded the way Settings is guarded: every key press stops here, so the
 * hidden workspace's shortcuts (a page turn, a block deleted) never hear one,
 * and focus is kept inside so a press always has a target here rather than the
 * body. Escape goes back.
 */
import { ArrowLeftIcon } from '@lucide/vue'

import OcrLabPage from '~/pages/ocr-lab.vue'

const route = useRoute()
const root = useTemplateRef<HTMLElement>('root')

/** Back to the workspace the lab was opened over, or to the list. */
function back () {
  const id = route.params.workspaceId

  navigateTo(id ? `/w/${encodeURIComponent(id)}` : '/')
}

function onKeys (event: KeyboardEvent) {
  event.stopPropagation()

  if (event.key === 'Escape') back()
}

onMounted(() => root.value?.focus())

useEventListener(document, 'focusin', (event: FocusEvent) => {
  // Only the body: a select opened from the lab lives in a portal at the body's
  // end, and is meant to have focus.
  if (event.target === document.body) root.value?.focus()
})
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    aria-label="OCR lab"
    tabindex="-1"
    class="bg-background text-foreground flex h-svh flex-col outline-none"
    @keydown="onKeys"
  >
    <TitleBar>
      <template #toolbar>
        <UButton variant="ghost" size="sm" @click="back">
          <ArrowLeftIcon class="size-4" />
          {{ route.params.workspaceId ? 'Back to the chapter' : 'Back to workspaces' }}
        </UButton>
      </template>
    </TitleBar>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <OcrLabPage />
    </div>
  </div>
</template>
