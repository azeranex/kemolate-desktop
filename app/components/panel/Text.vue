<script setup lang="ts">
/**
 * What the selected block says, and what it will say instead — the one panel
 * the whole application is really about.
 *
 * ## The source is editable, and used not to be
 *
 * The argument for read-only was that a source is *a reading of the page*, so
 * correcting it here corrects the record of what is printed rather than the
 * translation of it — and that a misread is fixed by reading the region again.
 *
 * The first half is true and the second is where it fell down. Reading again
 * runs the same engine over the same pixels and usually returns the same
 * misread; the reader can see the character the engine could not, and had no
 * way to say so. Meanwhile the source is what the prompt is built from, so one
 * wrong character quietly buys a wrong translation on every later attempt at
 * that line, and the only escape was to type the answer into the translation
 * box and lose it the moment anybody pressed Translate again.
 *
 * Nothing had to be built for this: `blockPatchSchema` has always accepted a
 * `source`, and `useBlockSync`'s own header names "retyping its source" among
 * the things it saves. The field was the only thing forbidding it.
 *
 * `confidence` beside it is now worth reading carefully. It is how sure the
 * *engine* was, about a reading that a person may since have replaced — see
 * `blockPatchSchema`, which leaves it out on purpose because nothing a letterer
 * does makes a past reading more or less certain. A hand-corrected line can
 * therefore show a low percentage and be perfectly right.
 *
 * With nothing selected there is nothing to say, and with several selected
 * there is no single thing to say — so both are told plainly rather than shown
 * an empty field that would take an edit and apply it to nobody.
 *
 * A block with no source is not a translation of anything: it is lettering
 * somebody placed with the Text tool, with no printed line behind it. So the
 * source box goes — an empty one reads as "the reading came back blank", which
 * is a different and worrying thing — and the buttons with it, since all three
 * are about carrying a printed line over. What is left is the one field that
 * means the same in both cases, under the name it actually has.
 *
 * That test is `printed` below rather than the source itself, and it has to be
 * now the field can be emptied — see it for why.
 */
import { CheckIcon, ChevronDownIcon, HistoryIcon, PinIcon, RefreshCwIcon, Trash2Icon, WandSparklesIcon } from '@lucide/vue'

const { selected, update, page } = useComic()

const { running, translateBlock } = useTranslate()

// Reading one block again is `useOcr`'s — it owns which engine reads and the
// key that engine may need. This panel only says which block.
const { readBlock, running: reading, error: readError, progress: readProgress } = useOcr()

const { list, pinned, trouble, available, missing, editable, choose, remove } = useRevisions()

const only = computed(() => (selected.value.length === 1 ? selected.value[0] : null))

/**
 * Whether the version list is showing.
 *
 * Shut on every new selection rather than remembered. It is a panel you open to
 * settle one line, and left open it would push the field you actually type in
 * off the top of the dock on every block you clicked.
 */
const open = ref(false)

/**
 * Whether this block is a translation *of* something — latched when it is
 * selected, not read live.
 *
 * Live, it would be `Boolean(only.source)`, and that was fine while the field
 * was read-only. Now that it can be emptied, reading it live means clearing the
 * box makes the box disappear — with no way to type into it again, because the
 * thing you would type into is what vanished. Latching answers the question
 * that is actually being asked ("did this block come off the page?") rather
 * than a proxy for it that the reader can accidentally falsify mid-edit.
 *
 * Cleared and set again on every change of selection, so a block genuinely left
 * without a source shows no source box the next time it comes round.
 */
const printed = ref(false)

/**
 * What this panel's own Re-read press is doing, and how it went.
 *
 * `useOcr`'s error and progress are one state shared with the Detect panel,
 * and that panel already draws them — but it may be shut, or docked on the
 * other side, and a press *here* that failed over *there* looks like a button
 * that does nothing. So this panel says it too, and only for its own presses:
 * `asked` is true while this button's read is in flight, and the complaint is
 * copied out of the shared state at the moment that read finishes. Pointing at
 * the shared error instead would pin a later page run's failure under a button
 * that had no part in it.
 */
const asked = ref(false)
const complaint = ref<string | null>(null)

async function reread () {
  if (!page.value || !only.value) return

  asked.value = true
  complaint.value = null

  const got = await readBlock(page.value.id, only.value.id)

  if (got === null) complaint.value = readError.value
  asked.value = false
}

watch(only, (block) => {
  open.value = false
  asked.value = false
  complaint.value = null
  printed.value = Boolean(block?.source)
}, { immediate: true })

/**
 * Whether there is a history to show at all.
 *
 * One revision counts, and the first version of this said two. That was wrong
 * for a reason worth writing down: with a threshold of two, a line translated
 * once has no control at all, so the feature is invisible until the day you
 * happen to translate the same line twice — and nobody discovers a feature they
 * have never seen. One version is also not nothing to show: it says which model
 * wrote the line, which is the question the panel is asked most often.
 */
const comparable = computed(() => available.value && list.value.length > 0)

/**
 * Why there is no list, when there is none — see `useRevisions.missing`.
 *
 * Desktop: versions are kept in the app's database, which a workspace from
 * before it is moved into when its chapter is next opened (`useMoveIn`); the web
 * build's sentence sends the reader to a cloud the desktop does not have.
 */
const WHY: Record<'unclaimed' | 'unsaved', string> = {
  unclaimed: 'Earlier wordings are kept once this chapter is in Kemolate’s database — it moves there when it opens.',
  unsaved: 'This block has not been saved to the chapter yet, so it has no versions.',
}

/**
 * What made a wording, in the two or three words a narrow row can hold.
 *
 * The model rather than the engine wherever there is one: `ai-text` is how this
 * app names a code path, and "Claude Sonnet 5.5" is what a person comparing two
 * translations actually wants to know. The engine only speaks for itself when
 * nothing else can — Google, or a line somebody typed.
 */
const ENGINE_LABEL: Record<string, string> = {
  human: 'Typed',
  google: 'Google',
  'ai-text': 'AI · Text',
  'ai-image': 'AI · Image',
  /** Something outside this app, through the MCP server — see `server/mcp/`. */
  agent: 'Agent',
}

function madeBy (revision: { engine: string, model: string | null }) {
  // `modelLabel` and not `modelById(...).label`: a row written through MCP
  // carries whatever the agent called itself, which is not on the curated list,
  // and `modelById` answers an unknown id with the *first* model on it. That
  // captioned an agent's translation with a stranger's name.
  if (revision.model) return modelLabel(revision.model)

  return ENGINE_LABEL[revision.engine] ?? revision.engine
}

/** Long enough ago to be worth a date; before that, how long ago. */
function when (at: string) {
  const then = new Date(at)
  const ago = Date.now() - then.getTime()

  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)}m ago`
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)}h ago`

  return then.toLocaleDateString()
}
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-3">
    <p v-if="!selected.length" class="text-muted-foreground py-1 text-xs">
      Select a block on the page to translate it.
    </p>

    <p v-else-if="!only" class="text-muted-foreground py-1 text-xs">
      {{ selected.length }} blocks selected. Pick one to edit its text.
    </p>

    <template v-else>
      <!--
        Editable, and the box is a textarea rather than an input for the reason
        the translation's is: a source is a balloon's worth of lettering, not a
        field, and one that scrolls sideways cannot be proofread against the
        page it came from.

        Written on every keystroke like the translation below, through the same
        `update` — so it lands on the undo stack and `useBlockSync` carries it to
        the row. Not on blur: a source is corrected a character at a time while
        looking at the artwork, and losing the lot by clicking the canvas to see
        it better is exactly the wrong failure.
      -->
      <div v-if="printed" class="grid gap-1.5">
        <div class="flex items-center justify-between">
          <UFieldLabel for="block-source">Source</UFieldLabel>
          <!--
            How sure the *engine* was, about a reading a person may since have
            replaced — see the header. Dimmed rather than hidden: it is still
            the honest answer to "how well was this read", and hiding it once
            edited would need a flag nothing records.
          -->
          <span class="text-muted-foreground font-mono text-[10px]">{{ only.confidence }}%</span>
        </div>
        <UTextarea
          id="block-source"
          :model-value="only.source"
          rows="2"
          spellcheck="false"
          class="resize-none text-sm"
          @update:model-value="update(only!.id, { source: String($event) })"
        />
      </div>

      <div class="grid gap-1.5">
        <UFieldLabel>{{ printed ? 'Translation' : 'Text' }}</UFieldLabel>
        <UTextarea
          :model-value="only.translation"
          rows="3"
          placeholder="Type the line as it should be lettered…"
          class="resize-none text-sm"
          @update:model-value="update(only!.id, { translation: String($event) })"
        />
      </div>

      <!--
        Said where the two texts sit side by side, because this is the panel
        that makes the split legible: the source is what was found *there* and
        the translation is what is set *here*, and once somebody has given the
        line room of its own those are two different rectangles on the page.

        A note rather than a control. Moving the frame back is the Lettering
        panel's, and this only has to stop the fact being a secret — the failure
        it heads off is a letterer widening a balloon, seeing the cleaned artwork
        stay the size it was, and taking that for a repair that has gone wrong.
        See `Block.letter`.
      -->
      <p v-if="only.letter" class="text-muted-foreground text-[11px] leading-snug">
        Lettered in a box of its own. The reading, and the artwork cleaned under
        it, stay where they were found.
      </p>

      <!--
        Translate here means *this line, again* — it replaces whatever is in the
        field, including words typed by hand. That is the opposite of the page
        button, which never overwrites, and the difference is deliberate: asking
        about one block is an explicit ask, and there would otherwise be no way
        to make one. See `useTranslate.translateBlock`.
      -->
      <div v-if="printed" class="flex flex-wrap gap-2">
        <UButton variant="outline" size="sm" :disabled="running" @click="translateBlock(only!.id)">
          <WandSparklesIcon class="size-4" /> Translate
        </UButton>
        <!--
          Reads this balloon again and replaces the *source* — what the page is
          understood to say. What it should say instead is the button beside it.
          The engine is whichever the Detect panel is set to; a crop of the
          block is what it is handed, so a reader that finds its own regions
          finds the one thing in the picture. See `useOcr.readBlock`.
        -->
        <UButton
          variant="outline"
          size="sm"
          :disabled="reading || running || !page?.scan"
          @click="reread"
        >
          <RefreshCwIcon class="size-4" /> Re-read
        </UButton>
      </div>

      <!--
        What this panel's own press is doing, or why it failed — see `asked`.
        The progress line matters most on the first press, when "nothing is
        happening" is actually a model downloading.
      -->
      <p v-if="asked && readProgress" class="text-muted-foreground truncate text-[11px]">
        {{ readProgress.message }}
      </p>
      <p v-else-if="complaint" class="text-destructive text-[11px] leading-snug">
        {{ complaint }}
      </p>

      <!--
        Every wording this line has had — Google's, each model's, and each of
        the reader's own — with the one on the page ticked.

        Shut by default and only offered when there are two to compare, because
        that is when it becomes a choice rather than a restatement of the box
        above. Choosing is not destructive: it puts a wording back and files
        the swap on the undo stack, so a comparison can be walked out of with
        Cmd+Z like any other edit. Removing a version is the one thing here
        that is, and it is asked for per row — see the button beside each.
      -->
      <div v-if="comparable" class="grid gap-1.5">
        <!--
          A plain toggle rather than a `Collapsible`: nothing else in this app
          uses one, and pulling a shadcn component in for a disclosure that is a
          button and a `v-if` would be adding a dependency to save two lines.
        -->
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[11px]"
          :aria-expanded="open"
          @click="open = !open"
        >
          <HistoryIcon class="size-3.5" />
          {{ list.length }} versions
          <!--
            Said here rather than only in the list, because it is the answer to
            a question the reader has while the list is *shut*: whether the next
            run will move this line.
          -->
          <span v-if="pinned" class="text-muted-foreground/70 flex items-center gap-1">
            · <PinIcon class="size-3" /> kept
          </span>
          <ChevronDownIcon class="size-3.5 transition-transform" :class="open && 'rotate-180'" />
        </button>

        <div v-if="open" class="grid gap-1">
          <!--
            The row and its remove button side by side rather than one inside
            the other: the row is itself a button, and a button in a button is
            invalid markup whose press the browser hands to whichever it likes.
          -->
          <div
            v-for="revision in list"
            :key="revision.id"
            class="group/revision relative min-w-0"
          >
            <button
              type="button"
              class="hover:bg-muted/60 grid w-full gap-0.5 rounded-md border px-2 py-1.5 text-left"
              :class="revision.head ? 'border-border bg-muted/40' : 'border-transparent'"
              :disabled="revision.head"
              @click="choose(revision.id)"
            >
              <span class="text-muted-foreground flex items-center gap-1.5 text-[10px]">
                <CheckIcon v-if="revision.head" class="text-primary size-3" />
                <span class="truncate">{{ madeBy(revision) }}</span>
                <!-- Room for the remove button, which sits over this end of the line. -->
                <span class="text-muted-foreground/70 ml-auto shrink-0" :class="!revision.head && editable && 'mr-5'">
                  {{ when(revision.at) }}
                </span>
              </span>
              <!--
                The wording itself, whole rather than truncated to a line. It is
                the only thing on the row worth reading, and a translation cut off
                mid-clause cannot be compared with the one under it — which is the
                entire purpose of the list.
              -->
              <span class="text-foreground text-xs/snug wrap-anywhere">
                {{ revision.text || '—' }}
              </span>
            </button>

            <!--
              Throwing a wording away — see `translations.deleteRevision`. Not
              offered on the one on the page: removing it would have to decide
              what the balloon says instead, so choose another first. Faint
              until the row is under the pointer, because a list of versions is
              read far more often than it is pruned.
            -->
            <button
              v-if="!revision.head && editable"
              type="button"
              class="text-muted-foreground hover:text-destructive focus-visible:text-destructive absolute top-1 right-1 rounded-sm p-0.5 opacity-40 group-hover/revision:opacity-100 focus-visible:opacity-100"
              :aria-label="`Remove this version: ${revision.text || 'empty'}`"
              title="Remove this version"
              @click="remove(revision.id)"
            >
              <Trash2Icon class="size-3" />
            </button>
          </div>

          <!--
            The way out of pinning, and it needs saying in words: it changes
            nothing on the page now, it only lets the next run move this line.
            An icon alone would read as "undo", which is a different thing.
          -->
          <UButton
            v-if="pinned"
            variant="ghost"
            size="sm"
            class="text-muted-foreground justify-start text-[11px]"
            @click="choose(null)"
          >
            <PinIcon class="size-3.5" />
            Stop keeping this — let the next run replace it
          </UButton>

          <!--
            A choice the server refused, said beside the rows it was made in.
            Without this the press was an unhandled rejection: the wording
            stayed put and nothing said why. See `useRevisions.trouble`.
          -->
          <p v-if="trouble" class="text-destructive text-[11px] leading-snug">
            {{ trouble }}
          </p>
        </div>
      </div>

      <!--
        And when there is no list, why — rather than nothing at all.

        Both of these are ordinary states of a local-first app: a chapter nobody
        has claimed has nowhere to keep a history, and a block read a moment ago
        has no row until it has been saved. Rendering nothing under either made
        the whole feature look absent, which is exactly how it was reported.
      -->
      <p v-else-if="missing && printed" class="text-muted-foreground text-[11px] leading-snug">
        {{ WHY[missing] }}
      </p>
    </template>
  </UFieldGroup>
</template>
