<script setup lang="ts">
/**
 * Opening a project file into this workspace — the picker, and the question
 * asked before it replaces what is open.
 *
 * Its own component because two places open one: the workspace settings'
 * Project file section and the File menu. The flow was written inside the first,
 * and a second copy of a destructive confirmation is the kind of copy that
 * drifts — one of them asks, the other one day does not. Whoever holds it calls
 * `choose()`.
 */
import { PROJECT_EXTENSION } from '~/utils/project'

const { load } = useProjectFile()
const { pages, title } = useComic()

const picker = ref<HTMLInputElement | null>(null)

/**
 * The file waiting on the question. The file rather than a flag: the picker's
 * input is cleared on the next open, and a dialog that confirmed a boolean
 * would go looking for a file that is no longer there.
 */
const asking = ref<File | null>(null)

/**
 * Whether the question is up — its own state rather than `Boolean(asking)`, and
 * that split is the fix for Import doing nothing.
 *
 * Import is an `AlertDialogAction`, which is reka's `DialogClose`, and its own
 * click handler — close the dialog — runs *before* the `@click` passed down to
 * it. When the dialog's openness was the file itself, closing cleared the file,
 * and `confirm` then found nothing to open: the dialog went away and the chapter
 * stayed as it was, without a word. (The web build's file reads exactly as this
 * one did.) So closing only closes, and the file is let go of a tick later
 * (`watch`, below) — after the click that closed it has finished, by which time
 * `confirm` has taken it if it was Import that was pressed.
 */
const open = ref(false)

watch(open, (now) => {
  if (!now) asking.value = null
})

function choose () {
  // Cleared before opening, so choosing the same file twice in a row still
  // fires `change` — an input holding its own value is the classic way a second
  // attempt at an import appears to do nothing.
  if (picker.value) picker.value.value = ''

  picker.value?.click()
}

function picked (event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]

  if (!file) return

  // Only asked over a chapter that is open, so the question is a real one.
  if (pages.value.length) {
    asking.value = file
    open.value = true

    return
  }

  load(file)
}

function confirm () {
  const file = asking.value

  asking.value = null
  open.value = false

  if (file) load(file)
}

defineExpose({ choose })
</script>

<template>
  <input
    ref="picker"
    type="file"
    :accept="PROJECT_EXTENSION"
    class="hidden"
    @change="picked"
  >

  <UAlertDialog v-model:open="open">
    <UAlertDialogContent>
      <UAlertDialogHeader>
        <UAlertDialogTitle>Replace “{{ title }}” with this project?</UAlertDialogTitle>
        <UAlertDialogDescription>
          Importing opens the chapter in the file instead of the one in this workspace —
          its pages, its reading and its retouching. What is open now is not deleted from
          your disk, but this workspace will no longer be pointing at it.
        </UAlertDialogDescription>
      </UAlertDialogHeader>
      <UAlertDialogFooter>
        <UAlertDialogCancel>Cancel</UAlertDialogCancel>
        <UAlertDialogAction @click="confirm">Import</UAlertDialogAction>
      </UAlertDialogFooter>
    </UAlertDialogContent>
  </UAlertDialog>
</template>
