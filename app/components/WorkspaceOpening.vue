<script setup lang="ts">
/**
 * Whether the chapter is still opening, and whether this page was ever cleaned.
 *
 * The two answers share a slot because they are one question asked at two
 * moments: "why is there no cleaning here?" While the chapter is opening the
 * answer is "it is on its way", and the bar says what it is waiting on; once it
 * has opened, the answer is "nobody cleaned this page", and the bar says that
 * instead. The two used to look identical, and telling them apart took a
 * developer — see `useOpening`.
 *
 * The progress waits before it appears. A chapter opened again in a production
 * build has its cleaning back in about a second, and a line that flashes up for
 * a moment and vanishes tells nobody anything; one that shows up when the wait
 * is long enough to wonder about is the whole point. It says nothing when it
 * finishes, because a chapter that opened is not news.
 *
 * "Not cleaned" is said only for a page that has lettering on it and none of it
 * repaired, and only with a cleaner chosen: under "None" the reader has said
 * their pages arrive clean, and a page with some balloons repaired has been
 * cleaned, whatever the rest were found to hold.
 */
import { LoaderCircleIcon } from '@lucide/vue'

/** How long a wait has to be before it is worth a line. */
const SHOW_AFTER = 400

const { current } = useOpening()
const { page } = useComic()
const { patchFor, repairs, running } = useClean()

const visible = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined

watch(() => current.value !== null, (busy) => {
  clearTimeout(timer)

  if (busy) timer = setTimeout(() => { visible.value = true }, SHOW_AFTER)
  else visible.value = false
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(timer))

const label = computed(() => {
  const now = current.value

  if (!now) return ''

  const count = now.total ? ` ${now.done} / ${now.total}` : ''

  if (now.stage === 'identify') return `Identifying pages…${count}`
  if (now.stage === 'reading') return 'Loading the reading…'
  if (now.stage === 'cleaning') return `Restoring cleaning…${count}`

  return 'Opening chapter…'
})

const uncleaned = computed(() => {
  if (current.value || running.value || !repairs.value) return false

  const here = page.value

  // No hash, no lookup — a page still being identified is not one that was
  // never cleaned.
  if (!here?.scan?.hash) return false

  const lettering = here.blocks.filter((block) => block.type !== 'garbage' && !block.hidden)

  return lettering.length > 0 && !lettering.some((block) => patchFor(here, block))
})
</script>

<template>
  <template v-if="visible && current">
    <div class="bg-border mx-1 h-4 w-px" />
    <LoaderCircleIcon class="text-muted-foreground size-3.5 shrink-0 animate-spin" />
    <span class="text-muted-foreground whitespace-nowrap tabular-nums">{{ label }}</span>
  </template>
  <template v-else-if="uncleaned">
    <div class="bg-border mx-1 hidden h-4 w-px @xl:block" />
    <span class="text-muted-foreground hidden whitespace-nowrap @xl:inline">not cleaned</span>
  </template>
</template>
