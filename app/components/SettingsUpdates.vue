<script setup lang="ts">
/**
 * Settings › Updates: the version running, and where the next one stands —
 * desktop only; see `useUpdates` and `electron/updates.ts`.
 *
 * Checked on its own at launch and every few hours; the button is for somebody
 * who has just heard there is a release. In development and on a test profile
 * the updater is off, and this says so rather than offering a check that would
 * find nothing to replace.
 */
import { LoaderCircleIcon, RefreshCwIcon } from '@lucide/vue'

const { state, check, install, available } = useUpdates()

const checking = ref(false)

async function checkNow () {
  checking.value = true

  try {
    await check()
  } finally {
    checking.value = false
  }
}

/** One line on where things stand. */
const said = computed(() => {
  const now = state.value

  if (!now) return ''

  switch (now.status) {
    case 'off': return 'Updates are off in development and on a test profile.'
    case 'checking': return 'Looking for a new version…'
    case 'none': return 'This is the newest version.'
    case 'downloading': return `Downloading ${now.next ?? 'the new version'}${now.percent ? ` — ${now.percent}%` : '…'}`
    case 'ready': return `${now.next} is downloaded. Restart to update, or it installs the next time you quit.`
    case 'error': return `Could not check for updates${now.message ? `: ${now.message}` : '.'}`
    default: return 'Checked at launch and every few hours.'
  }
})
</script>

<template>
  <section v-if="available && state" class="grid gap-4">
    <div class="flex items-center gap-2">
      <RefreshCwIcon class="text-muted-foreground size-4" />
      <h2 class="text-sm font-medium">
        Updates
      </h2>
    </div>

    <div class="border-border grid gap-3 rounded-md border p-4">
      <div class="grid gap-0.5">
        <p class="text-sm font-medium">
          Kemolate {{ state.version }}
        </p>
        <p class="text-muted-foreground text-xs">
          {{ said }}
        </p>
      </div>

      <div v-if="state.status !== 'off'" class="flex flex-wrap gap-2">
        <UButton v-if="state.status === 'ready'" size="sm" @click="install">
          Restart to update
        </UButton>
        <UButton
          v-else
          size="sm"
          variant="outline"
          :disabled="checking || state.status === 'checking' || state.status === 'downloading'"
          @click="checkNow"
        >
          <LoaderCircleIcon v-if="checking || state.status === 'checking'" class="size-4 animate-spin" />
          Check for updates
        </UButton>
      </div>
    </div>
  </section>
</template>
