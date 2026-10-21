<script setup lang="ts">
/**
 * The line that says some of this chapter's pictures are not on this computer,
 * and what can be done about it — the web build's bar, desktop.
 *
 * The chapter is all here: its pages, boxes, readings and translations come
 * from the app's database (`useShared.showMissing`). What is missing is the
 * picture, which was never copied — a page is the reader's own file, and a file
 * can be moved, renamed or left on a drive that is not plugged in. And when
 * the window's own storage is lost, which is what the database is there to
 * survive, every page is in this state until its file is given back.
 *
 * So the bar sits over the chapter rather than in place of it, and offers the
 * two ways to give the pictures back: open the folder, which matches every page
 * it can, or give one page its file from the page list or by dropping it on the
 * page (`useLibrary.link`). The web build's third — fetching from a
 * collaborator who has them — is not here; nobody else is.
 *
 * Dismissible for the session: a reader lettering a chapter they cannot see
 * should not be told about it over every page.
 */
import { FolderOpenIcon, ImageOffIcon, XIcon } from '@lucide/vue'

const { pages } = useComic()
const { openFolder } = useLibrary()

/** Dismissed here rather than in state: it is a fact about this window's session. */
const hidden = ref(false)

const absent = computed(() => pages.value.filter(isOffline).length)

/**
 * What is missing, written out rather than assembled in the template — see the
 * web build, whose first attempt came out saying the opposite of what it meant.
 */
const headline = computed(() => {
  if (absent.value === pages.value.length) return 'None of these pages’ files are here'
  if (absent.value === 1) return `1 of ${pages.value.length} pages’ files isn’t here`

  return `${absent.value} of ${pages.value.length} pages’ files aren’t here`
})
</script>

<template>
  <div
    v-if="absent && !hidden"
    class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-2"
  >
    <div
      class="bg-background/90 border-border pointer-events-auto flex max-w-full items-center gap-3
        rounded-md border px-3 py-2 shadow-sm backdrop-blur-xs"
    >
      <ImageOffIcon class="text-muted-foreground size-4 flex-none" />

      <div class="min-w-0 text-xs">
        <p class="font-medium">
          {{ headline }}
        </p>
        <!--
          The chapter is not missing and the sentence must not imply it is: the
          boxes, readings and translations are here and can be worked on.
        -->
        <p class="text-muted-foreground">
          The work on them is safe. Open their folder, or give a page its file from the page list.
        </p>
      </div>

      <UButton variant="outline" size="sm" class="flex-none" @click="openFolder">
        <FolderOpenIcon class="size-4" /> Open folder
      </UButton>

      <UButton variant="ghost" size="icon-sm" aria-label="Dismiss" class="flex-none" @click="hidden = true">
        <XIcon class="size-4" />
      </UButton>
    </div>
  </div>
</template>
