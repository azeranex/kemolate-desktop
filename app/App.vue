<script setup lang="ts">
/**
 * The app as the web build's workspace page draws it with no chapter open:
 * the header (here the title bar), the tool rail, the docks, the context bar
 * and the status bar — each slot filled the way that page fills it when there
 * is nothing to show. The File/Edit/View menu is not among them: it is the
 * app's rather than the page's, and sits in the title bar beside the mark.
 *
 * What the slots will hold once a chapter can be opened is the page's
 * (`pages/w/[workspaceId].vue`): the chapter's name, its settings, undo and
 * redo, the pager, the auto run; the tool's settings;
 * the selection, zoom and tally. Until those arrive, the controls that have
 * nothing to act on are drawn disabled — which is what the web build shows
 * when there is nothing to undo — rather than left out, so the header is the
 * header people know.
 */
import { FolderOpenIcon, Redo2Icon, Undo2Icon } from '@lucide/vue'

import Workspace from './layouts/Workspace.vue'

/**
 * Which palette the toasts are drawn from — see the web build's `app.vue`:
 * sonner keeps its own idea of light and dark, and left alone handed out the
 * light rich colours over a dark app.
 */
const { resolved } = useColorScheme()

const { tool } = useTools()
const label = computed(() => TOOLS.find((t) => t.id === tool.value)?.label)
</script>

<template>
  <div class="bg-background text-foreground flex h-screen flex-col text-sm">
    <TitleBar>
      <template #toolbar>
        <div class="flex min-w-0 items-center gap-2">
          <UButton variant="ghost" size="sm" class="min-w-0" disabled title="Opening a chapter has not been migrated yet">
            <FolderOpenIcon class="size-4 flex-none" />
            <span class="truncate">No chapter open</span>
          </UButton>

          <div class="bg-border h-5 w-px flex-none" />

          <UButton variant="ghost" size="icon-sm" disabled aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2Icon class="size-4" />
          </UButton>
          <UButton variant="ghost" size="icon-sm" disabled aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2Icon class="size-4" />
          </UButton>
        </div>
      </template>
    </TitleBar>

    <Workspace>
      <!-- The canvas arrives with the page engine; until then the work area says what it is for. -->
      <div class="text-muted-foreground grid size-full place-items-center text-sm">
        The page will be drawn here.
      </div>

      <!-- the tool that is out — its settings join it with the paint engine -->
      <template #context>
        <span class="text-foreground font-medium">{{ label }}</span>
      </template>

      <!-- and the state of it, along the bottom -->
      <template #status>
        <span class="whitespace-nowrap">No chapter open</span>
        <div class="flex-1" />
      </template>
    </Workspace>

    <!--
      Mounted once, at the root, because a toast outlives whatever raised it.
      Wider than the default: these say what went wrong and what to do about it.
    -->
    <UToaster
      position="bottom-center"
      rich-colors
      close-button
      :theme="resolved"
      :duration="5000"
      :style="{ '--width': '26rem' }"
    />
  </div>
</template>
