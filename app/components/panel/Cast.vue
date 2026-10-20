<script setup lang="ts">
/**
 * The comic's character appendix — who is in it, and what may not be guessed.
 *
 * The glossary keeps a name spelled the same way twice; it cannot say who the
 * name belongs to. A source that drops its pronouns leaves that to be inferred
 * from each line, and inferred afresh on every page it comes out differently on
 * every page — which is how a character changes sex halfway down a volume.
 * Written here once, it is sent with every page instead of guessed.
 *
 * ## A panel, not a dialog
 *
 * The earlier build made this a modal, which suited setting a cast up in one
 * sitting and suited nothing else. The correction you actually want to make is
 * one field wide and arrives mid-page — you read a line, notice the model has
 * decided somebody is a man, and want it fixed before the next press. A modal
 * over the page you are reading is the wrong shape for that; a docked column
 * you can leave open is the right one.
 *
 * ## Saved as one thing
 *
 * Edits go into a draft and reach the server on Save. A cast is a list of small
 * decisions and half of them are wrong while you are still typing them, so
 * nothing here should be in the next page's prompt until it is meant. That is
 * also why Save pins everything: looking at a row the model proposed and
 * leaving it alone is a decision, and this panel is where decisions are made.
 */
import { PlusIcon, Trash2Icon, UserRoundIcon } from '@lucide/vue'

const { members, notes, available: claimed, writable, save } = useCast()
const { target } = useTargetLanguage()

/** Short enough to sit in a row; the title says which is which. */
const GENDERS = [
  { id: 'male' as const, label: 'M', title: 'Male — he/him, and every word that agrees with it' },
  { id: 'female' as const, label: 'F', title: 'Female — she/her, and every word that agrees with it' },
  { id: 'nb' as const, label: 'NB', title: 'Non-binary — they/them' },
  { id: 'unknown' as const, label: '?', title: 'Not established — lines are written around the question rather than settling it' },
]

interface Draft {
  source: string
  names: Record<string, string>
  gender: 'male' | 'female' | 'nb' | 'unknown'
  tags: string[]
  pinned: boolean
}

const draft = ref<Draft[]>([])
const standing = ref('')
const saving = ref(false)

/**
 * Why the last save was refused — the same slot `Glossary.vue` keeps, for the
 * same reason. A cast edit that failed silently is worse here than almost
 * anywhere: the reader corrected a gender precisely because the model got it
 * wrong, believes it settled, and every later page goes on being prompted
 * with the wording they thought they had fixed.
 */
const problem = ref('')

/**
 * The draft is rebuilt from the list whenever the list changes underneath —
 * a page just translated, or a collaborator's edit arriving — but *not* while
 * somebody is part-way through editing, which would take the half-typed name
 * out from under them.
 */
const editing = ref(false)

function reset () {
  draft.value = members.value.map((row) => ({
    source: row.source,
    names: { ...(row.names ?? {}) },
    gender: row.gender,
    tags: [...(row.tags ?? [])],
    pinned: row.pinned,
  }))
  standing.value = notes.value
  editing.value = false
  problem.value = ''
}

watch([members, notes], () => { if (!editing.value) reset() }, { immediate: true, deep: true })

/** Whether the draft says anything the saved list does not. */
const dirty = computed(() => editing.value)

/** Tags are held as a list and typed as a line — one comma, one tag. */
const tagsOf = (member: Draft) => member.tags.join(', ')

function setTags (member: Draft, value: string) {
  member.tags = value.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 6)
  editing.value = true
}

function touch () {
  editing.value = true
}

function add () {
  draft.value.push({ source: '', names: {}, gender: 'unknown', tags: [], pinned: true })
  editing.value = true
}

function remove (at: number) {
  draft.value.splice(at, 1)
  editing.value = true
}

async function commit () {
  saving.value = true
  problem.value = ''

  try {
    // A row with no source name is one somebody started and abandoned. The
    // server drops it too; dropping it here keeps the two lists agreeing.
    await save(
      draft.value.filter((member) => member.source.trim()),
      standing.value,
    )
    editing.value = false
  } catch (error) {
    // `data` before `statusMessage`, as in `Glossary.vue`: the status line is
    // stripped to ASCII by h3, and a cast's names are the least ASCII strings
    // in this app. The draft stays on screen either way — a refused save must
    // not throw away the corrections it refused.
    const said = error as {
      statusMessage?: string
      data?: { message?: string, data?: { message?: string } }
    }

    problem.value = said?.data?.data?.message
      ?? said?.data?.message
      ?? said?.statusMessage
      ?? 'The cast could not be saved — try again.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UFieldGroup density="panel">
    <p v-if="!claimed" class="text-muted-foreground py-1 text-xs">
      Open a chapter to keep its cast, so names and genders stop being guessed page by page.
    </p>

    <template v-else>
      <!--
        Empty is the ordinary state of a chapter nobody has translated yet, and
        it should say what fills it rather than looking broken. Both halves are
        true and worth saying: the model fills this in as it meets people, and
        you add the ones you already know it gets wrong.
      -->
      <p v-if="!draft.length" class="text-muted-foreground border-border rounded-md border border-dashed px-3 py-4 text-center text-[11px]">
        Nobody yet. Translate a page and the model fills this in as it meets them — or add the
        ones you already know it gets wrong.
      </p>

      <div v-for="(member, index) in draft" :key="index" class="border-border grid gap-1.5 rounded-md border p-2">
        <div class="flex items-center gap-1.5">
          <UInput
            v-model="member.source"
            class="h-8 min-w-0 flex-1 text-xs"
            placeholder="Name in the source"
            spellcheck="false"
            :disabled="!writable"
            @update:model-value="touch"
          />
          <span class="text-muted-foreground flex-none text-xs">→</span>
          <!--
            Keyed by the chapter's target language: the row is shared across
            every language and only the spelling is per-language, so this field
            edits one entry of `names` rather than the member.
          -->
          <UInput
            :model-value="member.names[target] ?? ''"
            class="h-8 min-w-0 flex-1 text-xs"
            :placeholder="`Name in ${target}`"
            spellcheck="false"
            :disabled="!writable"
            @update:model-value="member.names[target] = String($event); touch()"
          />
        </div>

        <div class="flex items-center gap-1.5">
          <UToggleGroup
            type="single"
            variant="outline"
            size="sm"
            :model-value="member.gender"
            :disabled="!writable"
            @update:model-value="member.gender = ($event as Draft['gender']) || member.gender; touch()"
          >
            <UToggleGroupItem
              v-for="option in GENDERS"
              :key="option.id"
              :value="option.id"
              :title="option.title"
              class="aria-pressed:text-primary h-7 px-2 text-[11px]"
            >
              {{ option.label }}
            </UToggleGroupItem>
          </UToggleGroup>

          <UInput
            :model-value="tagsOf(member)"
            class="h-7 min-w-0 flex-1 text-[11px]"
            placeholder="role, register…"
            spellcheck="false"
            :disabled="!writable"
            @update:model-value="setTags(member, String($event))"
          />

          <UButton
            variant="ghost"
            size="icon-sm"
            class="flex-none"
            :disabled="!writable"
            :aria-label="`Remove ${member.source || 'this character'}`"
            @click="remove(index)"
          >
            <Trash2Icon class="size-3.5" />
          </UButton>
        </div>

        <!--
          Said only for the rows it is not true of. An unpinned entry is one the
          model proposed and later pages may still fill in its blanks; that is
          worth knowing before you rely on it, and saying it on every row would
          be saying nothing.
        -->
        <p v-if="!member.pinned" class="text-muted-foreground text-[10.5px]">
          Proposed while translating — later pages may still fill this in. Saving settles it.
        </p>
      </div>

      <UButton
        variant="outline"
        size="sm"
        class="justify-start"
        :disabled="!writable || draft.length >= 30"
        @click="add"
      >
        <PlusIcon class="size-4" />
        Add a character
      </UButton>

      <USeparator />

      <UField>
        <UFieldLabel for="cast-notes">About this comic</UFieldLabel>
        <UTextarea
          id="cast-notes"
          v-model="standing"
          rows="3"
          class="resize-none text-xs"
          placeholder="Setting, register, how these people speak to each other…"
          :disabled="!writable"
          @update:model-value="touch"
        />
        <UFieldDescription>
          Sent with every page, and it outranks the model's own reading of one.
        </UFieldDescription>
      </UField>

      <p v-if="problem" class="text-destructive text-[11px] leading-snug">
        {{ problem }}
      </p>

      <!--
        Only once there is something to save. A button that is always there and
        usually does nothing teaches you to ignore it, which is exactly wrong
        for the one control that decides whether your edits reach the prompt.
      -->
      <UButtonGroup v-if="dirty" class="w-full">
        <UButton size="sm" class="flex-1" :disabled="saving || !writable" @click="commit">
          <UserRoundIcon class="size-4" />
          Save the cast
        </UButton>
        <UButton variant="outline" size="sm" :disabled="saving" @click="reset">
          Discard
        </UButton>
      </UButtonGroup>

      <p v-else-if="!writable" class="text-muted-foreground text-[11px]">
        You need translator access to change who is in this comic.
      </p>
    </template>
  </UFieldGroup>
</template>
