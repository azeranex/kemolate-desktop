<script setup lang="ts">
/**
 * What this workspace is called and where it is kept, in one place.
 *
 * It was a pencil that opened a rename dialog, which was the right size for a
 * name and the wrong shape for anything else — and "where is this kept" turned
 * out to belong right beside it, because both are answers to *what is this
 * workspace*.
 *
 * ## Desktop: a partial port
 *
 * The web build's popover, without its cloud half. Gone: the switch that moves
 * a workspace into an account and back (`toCloud`/`toLocal`), the contributors
 * it has to check first, and the "On the server" line, because every workspace
 * here is local and there is no server. With them went the trigger's "Local"
 * wording — the workspace list dropped the same badge, since it said the same
 * thing about everything — so the trigger is the gear alone. What is left is the
 * part that was always about this machine: the name, the reading direction, and
 * what is kept where, worded for an app rather than a browser.
 */
import { FolderOpenIcon, HardDriveIcon, SettingsIcon, ShieldCheckIcon } from '@lucide/vue'

const { name, renameable, rename } = useWorkspaceName()
const { kind } = useLibrary()
const { persisted, used, quota, asking, look, ask } = useStorageStanding()
const { direction, directions, set: setDirection } = useReadingDirection()

/** The chosen way round, for the sentence under the picker. */
const chosen = computed(() => directions.find((way) => way.value === direction.value) ?? directions[0]!)

/**
 * A select hands its value back on every open as well as on every change, and
 * publishing an unchanged direction would write for nothing having happened.
 */
function onDirection (next: unknown) {
  if ((next === 'ltr' || next === 'rtl') && next !== direction.value) setDirection(next)
}

/**
 * Where this chapter's pages actually are, in one sentence — read out of the
 * reader's own folder, or copied into the app's storage. Same canvas either
 * way, very different answers to "what happens if I delete that folder".
 */
const pages = computed(() => {
  if (kind.value === 'handle') return 'Read from the folder you opened. Nothing is copied.'
  if (kind.value === 'copy') return 'Copied into this app’s own storage.'

  return 'No chapter is open in this workspace yet.'
})

const open = ref(false)
const draft = ref('')

watch(open, (showing) => {
  if (!showing) return

  draft.value = name.value
  look().catch(() => {})
})

/**
 * Follow the name when it changes under an open popover — unless somebody is
 * typing in the box. Importing a project renames the chapter, and a box still
 * holding the old name would rename it back on blur.
 */
watch(name, (now) => {
  if (!open.value || document.activeElement?.id === 'workspace-name') return

  draft.value = now
})

async function commitName () {
  const wanted = draft.value.trim()

  if (!wanted || wanted === name.value) return

  await rename(wanted)
}
</script>

<template>
  <UPopover v-model:open="open">
    <UPopoverTrigger as-child>
      <UButton variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Workspace settings" title="Workspace settings">
        <SettingsIcon class="size-4" />
      </UButton>
    </UPopoverTrigger>

    <UPopoverContent align="start" class="w-80">
      <UFieldGroup data-density="popover">
        <UField>
          <UFieldLabel for="workspace-name">Name</UFieldLabel>
          <UInput
            id="workspace-name"
            v-model="draft"
            class="h-8"
            :disabled="!renameable"
            :maxlength="200"
            placeholder="Chapter 12"
            @blur="commitName"
            @keydown.enter.prevent="commitName"
          />
        </UField>

        <!--
          Which end of the page the chapter starts at — a fact about the book,
          beside its name. It sets the order the blocks on a page are put in,
          and that order is what the model is handed as "reading order", so
          getting it wrong feeds a translator the conversation backwards. See
          `useReadingDirection`.
        -->
        <UField>
          <UFieldLabel for="workspace-direction">Reading direction</UFieldLabel>
          <USelect
            :model-value="direction"
            :disabled="!renameable"
            @update:model-value="onDirection"
          >
            <USelectTrigger id="workspace-direction" size="sm" class="w-full">
              <USelectValue />
            </USelectTrigger>
            <USelectContent>
              <USelectItem v-for="way in directions" :key="way.value" :value="way.value">
                {{ way.label }}
              </USelectItem>
            </USelectContent>
          </USelect>
          <UFieldDescription>{{ chosen.note }}</UFieldDescription>
        </UField>

        <UFieldSeparator />

        <!--
          What is where, for a reader who has every right to ask: the pages,
          and the work done on them. Facts rather than reassurance.
        -->
        <UFieldSet>
          <UFieldLegend variant="label">Where things are kept</UFieldLegend>

          <UFieldGroup>
            <UField>
              <UFieldTitle>
                <FolderOpenIcon class="size-3.5 flex-none" /> Pages
              </UFieldTitle>
              <UFieldDescription>{{ pages }}</UFieldDescription>
            </UField>

            <UField>
              <UFieldTitle>
                <HardDriveIcon class="size-3.5 flex-none" /> Reading, paint and repairs
              </UFieldTitle>
              <UFieldDescription>In this app’s own storage on this computer, filed under each page’s own content.</UFieldDescription>
            </UField>

            <!--
              Whether the storage is kept, rather than cleared when space runs
              short — the app's profile asks for this, and on the desktop it is
              normally granted already; shown so the answer is somewhere.
            -->
            <UField v-if="persisted !== null">
              <UFieldTitle>
                <ShieldCheckIcon class="size-3.5 flex-none" /> Staying put
              </UFieldTitle>
              <UFieldDescription v-if="persisted">
                Kept until you delete it<template v-if="used"> — {{ formatBytes(used) }} used<template v-if="quota"> of {{ formatBytes(quota) }}</template></template>.
              </UFieldDescription>
              <UFieldDescription v-else>
                May be cleared when space runs short<template v-if="used"> — {{ formatBytes(used) }} used</template>.
                <UButton
                  variant="link"
                  size="sm"
                  class="text-primary h-auto p-0 text-xs"
                  :disabled="asking"
                  @click="ask"
                >
                  {{ asking ? 'Asking…' : 'Ask to keep it' }}
                </UButton>
              </UFieldDescription>
            </UField>
          </UFieldGroup>
        </UFieldSet>
      </UFieldGroup>
    </UPopoverContent>
  </UPopover>
</template>
