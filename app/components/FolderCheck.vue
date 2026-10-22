<script setup lang="ts">
/**
 * Desktop: "open all of this?" for a folder past `useFolderCheck`'s marks.
 *
 * Closing by any means is a no, as `PdfPassword`'s closing is an answer: an
 * unanswered question is an open that waits for ever.
 */
import { FolderOpenIcon } from '@lucide/vue'

const { asked } = useFolderCheck()

// The no is put off a turn: reka's buttons close the dialog before their own
// click runs (see `ProjectImport`), so answered at once, "Open it" was a no.
const open = computed({
  get: () => Boolean(asked.value),
  set: (next) => { if (!next) setTimeout(() => asked.value?.answer(false)) },
})

// Kept for the fade, as `PdfPassword` keeps its request: the question is
// cleared the instant it is answered, and the sentence should not empty first.
const showing = shallowRef(asked.value)

watch(asked, (next) => { if (next) showing.value = next })

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What is in it, said the way it matters: the books first, then the rest. */
const holds = computed(() => {
  const tally = showing.value

  if (!tally) return ''

  const loose = tally.files - tally.pdfs

  if (!tally.pdfs) return count(loose, 'file', 'files')
  if (!loose) return count(tally.pdfs, 'PDF', 'PDFs')

  return `${count(tally.pdfs, 'PDF', 'PDFs')} and ${count(loose, 'other file', 'other files')}`
})

/** Several books run together, which is the surprise worth naming. */
const books = computed(() => (showing.value?.pdfs ?? 0) > 1 ? ' — the PDFs one after another, in name order' : '')
</script>

<template>
  <UAlertDialog v-model:open="open">
    <UAlertDialogContent>
      <UAlertDialogHeader>
        <UAlertDialogTitle class="flex items-center gap-2">
          <FolderOpenIcon class="size-4 shrink-0" />
          Open all of {{ showing?.name ?? 'this folder' }}?
        </UAlertDialogTitle>
        <UAlertDialogDescription>
          It holds {{ holds }}, subfolders included, and every one becomes a page
          of one chapter{{ books }}. That can take a while.
        </UAlertDialogDescription>
      </UAlertDialogHeader>
      <UAlertDialogFooter>
        <UAlertDialogCancel @click="asked?.answer(false)">
          Cancel
        </UAlertDialogCancel>
        <UAlertDialogAction @click="asked?.answer(true)">
          Open it
        </UAlertDialogAction>
      </UAlertDialogFooter>
    </UAlertDialogContent>
  </UAlertDialog>
</template>
