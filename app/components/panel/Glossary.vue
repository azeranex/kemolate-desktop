<script setup lang="ts">
/**
 * The terms this chapter has settled on, in the language it is being carried
 * into.
 *
 * The cast's sibling and sits beside it, because they are the same kind of
 * thing: what the chapter has decided about its words, sent with every page,
 * edited rarely and referenced often. The one keeps a *name* spelled the same
 * way twice; the other keeps track of who the name belongs to.
 *
 * ## Why it left the Translate panel
 *
 * It lived there as a count, then briefly as an editor squeezed into a
 * collapsible, and neither survived the list becoming editable. `Translate.vue`
 * was nine hundred lines carrying the engine, the model, the language, two
 * switches, the cost ledger and the run buttons — every one of which is a
 * *setting for the next press*. The glossary is not: it is a record of what has
 * already been decided, and it belongs where the cast is.
 *
 * The Translate panel keeps a read-only count, which is a different question
 * with an honest place there — how many terms the next press will send.
 *
 * ## One list per language, unlike the cast
 *
 * The difference worth showing rather than hiding, and the reason these are two
 * panels instead of one. The target half of every row is written in one
 * language, so a chapter carried into Korean and then into Spanish has two
 * glossaries and neither is any use to the other — where a character's gender
 * is a fact about the person and does not change with the language at all.
 */
import { PlusIcon, Trash2Icon } from '@lucide/vue'

import type { GlossaryRow } from '~/composables/useGlossary'

// Where the terms are kept, and who may change them, is `useGlossary`'s to say:
// on the server for a cloud workspace, in this browser for a local one.
const { terms, available: claimed, writable, set: setTerm, amend, forget, clear } = useGlossary()
const { target, languages } = useTargetLanguage()

/** The language these terms are written in, spelled out rather than as a code. */
const language = computed(() =>
  languages.find((option) => option.value === target.value)?.label ?? target.value)

/**
 * Why the last write was refused.
 *
 * Shown rather than swallowed, unlike the rest of this pipeline: a term the
 * *model* failed to record costs consistency on later pages and nothing you can
 * see, where a term **you** typed failing to save is one you will believe is
 * saved and rely on for the rest of the chapter.
 */
const problem = ref('')

/** Bumped to rebuild the inputs from what is stored — see `refused`. */
const nonce = ref(0)

function refused (error: unknown) {
  const said = error as {
    statusMessage?: string
    data?: { message?: string, data?: { message?: string } }
  }

  // `data` before `statusMessage`: that one is written into the HTTP status
  // line, so h3 strips it to ASCII — and a glossary's terms are the least ASCII
  // strings in this app. `"桜町" is already on the list` arrived as `"" is
  // already on the list`, which names no term and reads like a bug.
  problem.value = said?.data?.data?.message
    ?? said?.data?.message
    ?? said?.statusMessage
    ?? 'That term could not be saved.'

  // Throw the inputs away and build them again from what is stored. Writing
  // `.value` on the element does not work: `UInput` keeps its own copy through
  // `useVModel`, so the next render puts the rejected text straight back and the
  // panel goes on showing a term the server refused.
  nonce.value += 1
}

/**
 * Save a corrected half, if it actually changed.
 *
 * Blur fires on every pass through a field, including tabbing across one
 * untouched, and a write per glance would be a log entry and a notice to every
 * collaborator for nothing having happened.
 */
async function edit (term: GlossaryRow, half: 'source' | 'target', event: FocusEvent) {
  const value = (event.target as HTMLInputElement).value.trim()

  if (!value || value === term[half]) {
    // A box emptied and left is a refusal, not an instruction to delete a term.
    nonce.value += 1

    return
  }

  problem.value = ''

  await amend(term.id, { [half]: value }).catch(refused)
}

/**
 * The row being typed, held apart from the list.
 *
 * Its own state rather than an empty row appended to `terms`, and that is what
 * the room here buys. The list re-reads itself whenever a page is translated or
 * a collaborator edits it, so a draft living inside it would be wiped from
 * under whoever was typing — which is why the cramped version in the Translate
 * panel resorted to two `window.prompt`s. Kept outside, it simply survives.
 */
const draft = ref({ source: '', target: '' })

const addable = computed(() =>
  writable.value && Boolean(draft.value.source.trim() && draft.value.target.trim()) && terms.value.length < 40)

async function add () {
  if (!addable.value) return

  problem.value = ''

  try {
    await setTerm(draft.value.source.trim(), draft.value.target.trim())
    draft.value = { source: '', target: '' }
  } catch (error) {
    refused(error)
  }
}

async function forgetAll () {
  problem.value = ''

  await clear().catch(refused)
}
</script>

<template>
  <UFieldGroup density="panel">
    <p v-if="!claimed" class="text-muted-foreground py-1 text-xs">
      Open a chapter to keep its terms, so a name is the same name on every page.
    </p>

    <template v-else>
      <!--
        Which language these are the renderings *in*, said once at the top. The
        cast panel needs no such line and this one does: the list changes
        entirely with the target language, and a reader who has just switched
        would otherwise see it empty with no explanation.
      -->
      <p class="text-muted-foreground text-[11px]">
        Sent with every page, so a name is the same name throughout.
        Renderings are in <span class="text-foreground">{{ language }}</span>.
      </p>

      <p
        v-if="!terms.length"
        class="text-muted-foreground border-border rounded-md border border-dashed px-3 py-4 text-center text-[11px]"
      >
        Nothing settled yet. Translate a page and the model adds the names it meets — or type
        the ones you already know it gets wrong.
      </p>

      <div v-else class="grid gap-1">
        <div class="text-muted-foreground grid grid-cols-[1fr_auto_1fr_auto] gap-1 text-[10px] tracking-wide uppercase">
          <span>On the page</span>
          <span />
          <span>Reads as</span>
          <span />
        </div>

        <div
          v-for="term in terms"
          :key="`${term.id}:${nonce}`"
          class="group/term grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1"
        >
          <!--
            `min-w-0` on the cells, not only the text: a grid item's automatic
            minimum is its min-content width, so one long term would size the
            column to itself and push the bin out of the dock.
          -->
          <UInput
            :model-value="term.source"
            class="h-7 min-w-0 px-1.5 text-xs"
            spellcheck="false"
            :disabled="!writable"
            :aria-label="`Source for ${term.target}`"
            @blur="edit(term, 'source', $event)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <span class="text-muted-foreground/60 text-xs">→</span>
          <UInput
            :model-value="term.target"
            class="h-7 min-w-0 px-1.5 text-xs"
            spellcheck="false"
            :disabled="!writable"
            :aria-label="`Rendering of ${term.source}`"
            @blur="edit(term, 'target', $event)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <UButton
            variant="ghost"
            size="icon-sm"
            class="size-7 opacity-0 group-hover/term:opacity-100 focus-within:opacity-100 focus-visible:opacity-100"
            :disabled="!writable"
            :aria-label="`Forget ${term.source}`"
            @click="forget(term.id)"
          >
            <Trash2Icon class="size-3.5" />
          </UButton>
        </div>
      </div>

      <!--
        The draft row, always there rather than revealed by a button: an empty
        pair of boxes is its own invitation, and a press to make them appear is
        a press that teaches nothing.
      -->
      <div v-if="writable" class="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1">
        <UInput
          v-model="draft.source"
          class="h-7 min-w-0 px-1.5 text-xs"
          placeholder="山田"
          spellcheck="false"
          :disabled="terms.length >= 40"
          aria-label="A new term as the page writes it"
          @keydown.enter="add"
        />
        <span class="text-muted-foreground/60 text-xs">→</span>
        <UInput
          v-model="draft.target"
          class="h-7 min-w-0 px-1.5 text-xs"
          placeholder="Yamada"
          spellcheck="false"
          :disabled="terms.length >= 40"
          aria-label="What it should read as"
          @keydown.enter="add"
        />
        <UButton
          variant="ghost"
          size="icon-sm"
          class="size-7"
          :disabled="!addable"
          aria-label="Add this term"
          @click="add"
        >
          <PlusIcon class="size-3.5" />
        </UButton>
      </div>

      <p v-if="problem" class="text-destructive text-[11px] leading-snug">
        {{ problem }}
      </p>

      <!--
        The ceiling is the server's and is said here rather than reached by
        surprise: the list is prepended to every page of a run, so it is paid
        for once per page and a model handed two hundred terms starts ignoring
        them. Worth knowing *before* the run stops learning.
      -->
      <p v-if="terms.length >= 40" class="text-muted-foreground text-[11px] leading-snug">
        Full at 40 terms — nothing new will be learned until one is removed.
      </p>

      <template v-if="terms.length">
        <USeparator />

        <UButton
          variant="ghost"
          size="sm"
          class="text-muted-foreground hover:text-destructive justify-start text-[11px]"
          :disabled="!writable"
          @click="forgetAll"
        >
          <Trash2Icon class="size-3.5" />
          Forget all {{ terms.length }} terms
        </UButton>
      </template>
    </template>
  </UFieldGroup>
</template>
