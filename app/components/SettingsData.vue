<script setup lang="ts">
/**
 * Settings › Your data: where the work is kept, its backups, and the way back to
 * one of them — desktop only.
 *
 * Everything a workspace has but its pictures lives in one SQLite file the app
 * owns (`electron/database.ts`), backed up on its own: at launch, hourly while
 * anything changed, and on quit, a day of them kept and then one a day for a
 * month. This is where a reader can see that that is true — the file, how
 * recent the newest backup is — make one now, open the folder they are in, and
 * put one back.
 *
 * Restoring replaces every workspace's work with the backup's, so it is asked
 * about first, in those words, and happens at the next launch (the app
 * relaunches): the database is open while the app runs and cannot be swapped
 * under it. The file it replaces is kept beside it, renamed, never deleted —
 * so a restore pressed by mistake can be undone by hand.
 */
import { ArchiveRestoreIcon, DatabaseIcon, FolderOpenIcon, LoaderCircleIcon } from '@lucide/vue'

import type { Backup } from '../../electron/preload'

const data = typeof window === 'undefined' ? undefined : window.kemolate?.data

const about = ref<{ file: string, folder: string, backups: Backup[] } | null>(null)
const backingUp = ref(false)
const chosen = ref<Backup | null>(null)
const restoring = ref(false)

async function refresh () {
  about.value = await data?.about().catch(() => null) ?? null
}

onMounted(refresh)

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const newest = computed(() => about.value?.backups[0] ?? null)

async function backUp () {
  if (!data || backingUp.value) return

  backingUp.value = true

  try {
    await data.backup()
    await refresh()
    toast.success('Backed up')
  } catch (error) {
    toast.error('Could not make a backup', { description: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) })
  } finally {
    backingUp.value = false
  }
}

async function restore () {
  if (!data || !chosen.value || restoring.value) return

  restoring.value = true

  // Answered by the app quitting and starting again.
  await data.restore(chosen.value.name).catch((error: unknown) => {
    restoring.value = false
    toast.error('Could not restore that backup', { description: error instanceof Error ? error.message : String(error) })
  })
}
</script>

<template>
  <section v-if="data && about" class="grid gap-4">
    <div class="flex items-center gap-2">
      <DatabaseIcon class="text-muted-foreground size-4" />
      <h2 class="text-sm font-medium">
        Your data
      </h2>
    </div>

    <div class="border-border grid gap-3 rounded-md border p-4">
      <div class="grid gap-0.5">
        <p class="text-sm font-medium">
          Kept in Kemolate’s database on this computer
        </p>
        <p class="text-muted-foreground text-xs">
          Every workspace’s readings, translations, layers, retouching, glossary and cast. The pages
          themselves are your files and stay where they are. Backed up at launch, every hour anything
          changes, and on quit — a day of backups kept, then one a day for 30 days.
        </p>
        <p class="text-muted-foreground font-mono text-[11px] break-all">
          {{ about.file }}
        </p>
      </div>

      <p class="text-xs">
        <template v-if="newest">
          Last backup {{ when.format(newest.at) }} · {{ about.backups.length }} kept · {{ formatBytes(newest.bytes) }} each
        </template>
        <template v-else>
          No backup yet.
        </template>
      </p>

      <div class="flex flex-wrap gap-2">
        <UButton size="sm" variant="outline" :disabled="backingUp" @click="backUp">
          <LoaderCircleIcon v-if="backingUp" class="size-4 animate-spin" />
          Back up now
        </UButton>
        <UButton size="sm" variant="ghost" @click="data.openBackups()">
          <FolderOpenIcon class="size-4" /> Open backups folder
        </UButton>
      </div>

      <!--
        The backups, newest first. A restore is one row's button rather than a
        picker beside a button, so what is being put back is the thing pressed.
      -->
      <ul v-if="about.backups.length" class="border-border grid max-h-56 overflow-y-auto rounded-md border">
        <li
          v-for="backup in about.backups"
          :key="backup.name"
          class="border-border flex min-w-0 items-center gap-3 border-b px-3 py-1.5 text-xs last:border-b-0"
        >
          <span class="flex-1 tabular-nums">{{ when.format(backup.at) }}</span>
          <span class="text-muted-foreground font-mono tabular-nums">{{ formatBytes(backup.bytes) }}</span>
          <UButton size="xs" variant="ghost" @click="chosen = backup">
            <ArchiveRestoreIcon class="size-3.5" /> Restore
          </UButton>
        </li>
      </ul>
    </div>

    <UAlertDialog :open="!!chosen" @update:open="(open: boolean) => { if (!open && !restoring) chosen = null }">
      <UAlertDialogContent>
        <UAlertDialogHeader>
          <UAlertDialogTitle>Restore the backup from {{ chosen ? when.format(chosen.at) : '' }}?</UAlertDialogTitle>
          <UAlertDialogDescription>
            Every workspace’s work goes back to how it was then — anything done since is not in it.
            Kemolate restarts to do it. The database it replaces is kept beside it, renamed, so this
            can be undone by hand.
          </UAlertDialogDescription>
        </UAlertDialogHeader>
        <UAlertDialogFooter>
          <UAlertDialogCancel :disabled="restoring">
            Cancel
          </UAlertDialogCancel>
          <UButton :disabled="restoring" @click="restore">
            <LoaderCircleIcon v-if="restoring" class="size-4 animate-spin" />
            Restore and restart
          </UButton>
        </UAlertDialogFooter>
      </UAlertDialogContent>
    </UAlertDialog>
  </section>
</template>
