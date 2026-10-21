<script setup lang="ts">
/**
 * How lines are carried over — as opposed to what any one line says, which is
 * the Text panel's business.
 *
 * The split is deliberate. These settings belong to the job and hold for every
 * block on every page; the text panel holds one block's words. Putting them
 * together would mean the engine and the glossary went out of reach the moment
 * nothing was selected, which is exactly when they are most likely to be set.
 */
import { BookMarkedIcon, ChevronDownIcon, ChevronsUpDownIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon, Undo2Icon, WandSparklesIcon } from '@lucide/vue'

const { translate } = useComic()

const {
  progress,
  error,
  kept,
  running,
  pending,
  pendingPages,
  canRedo,
  redoPages,
  estimate,
  lastRun,
  translateCurrent,
  translateAll,
  revertRun,
  stop,
  stopping,
  stoppable,
} = useTranslate()

// Desktop: whether the database keeps this workspace's revisions — see the run's undo, below.
const { shared } = useShared()

// Only the count. The list, its editor and everything that failed while saving
// one are `Glossary.vue`'s — see its header for why they left this panel.
const { terms } = useGlossary()

/**
 * What these models cost, asked of OpenRouter rather than made up here.
 *
 * From this panel's mount, because this is the only place the answer is used
 * and a reader who never opens it should not spend a request on it. Once per
 * session — `refresh` returns immediately after the first — so re-opening the
 * dock column is free.
 */
const { models, byId, refresh: refreshModels } = useModels()

onMounted(refreshModels)

/** Every AI call made against this chapter, and what they came to. */
const { rows, total } = useAiUsage()

/**
 * The three ways a line can be got at, in order of how much they are given.
 *
 * Google is handed the text and nothing else. AI Text is handed the same text
 * with the rest of the page around it, so a line can be read in light of the
 * one before it. AI Image is handed the picture itself and reads it directly —
 * the only one that can do anything with lettering no reader could pick out,
 * which is the same distinction the two region tools in the rail are drawn on.
 */
const ENGINES: { value: TranslateEngine, label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'ai-text', label: 'AI · Text' },
  { value: 'ai-image', label: 'AI · Image' },
]

/**
 * The curated list, in the shape this panel draws — see `shared/utils/models`.
 *
 * Drawn from there rather than written here, because three copies of this list
 * existed and disagreed: this one, the one the browser actually calls
 * OpenRouter with, and a third in the translate state. The ids are OpenRouter's
 * now, prefix and all, since that is what gets sent.
 *
 * A `computed` over `useModels`, and it has to be. This was
 * `AI_MODELS.map((model) => ({ …, in: model.price.in }))` — evaluated once at
 * setup, copying the built-in placeholder prices into a snapshot. The fetch
 * that was supposed to replace them rewrote the shared array in place, which
 * this could not see even in principle, and nothing called it in any case. So
 * the price on every row, and the cost under it, were invented numbers with no
 * route to becoming real ones.
 */
// Desktop: a free model chosen before the catalogue has answered is listed anyway, so the
// picker shows what is in force rather than the first entry — see `useModels.byId`.
const listed = computed(() => (models.value.some((model) => model.id === translate.value.model) || !isFreeModel(translate.value.model)
  ? models.value
  : [...models.value, byId(translate.value.model)]))

const MODELS = computed(() => listed.value.map((model) => ({
  value: model.id,
  free: Boolean(model.free),
  label: model.label,
  desc: model.note,
  vision: model.vision,
  // Trimmed, because the fetched rate is a per-token string multiplied by a
  // million and comes back as things like 2.9999999999999996. Two decimals
  // where they say something, none where they do not — `$0.15/M` and `$3/M`
  // both read as prices; `$3.00/M` reads as a spreadsheet.
  in: Number(model.price.in.toFixed(2)),
})))

/**
 * What each setting asks of a model.
 *
 * The share of thinking each one buys used to live here too, and moved to
 * `useTranslate`: it decides a third of the bill on the thorough setting, and a
 * number that decides what somebody is charged does not belong in a list of
 * labels.
 */
const EFFORTS: { value: Effort, label: string, desc: string }[] = [
  // "No thinking" said out loud, because on a reasoning model it is the setting
  // that decides most of the bill and the only one that can switch it off.
  { value: 'fast', label: 'Fast', desc: 'No thinking — one pass. Best for plain dialogue and drafts.' },
  { value: 'balanced', label: 'Balanced', desc: 'Goes back over the lines it found hardest.' },
  { value: 'thorough', label: 'Thorough', desc: 'Weighs other readings before settling on one.' },
]

/**
 * The target is the workspace's, not this panel's — see `useTargetLanguage`.
 * Everything else on this panel is a way of working and belongs to whoever is
 * doing it; the language a chapter comes out in belongs to the chapter.
 */
const { target, languages, set: setTarget } = useTargetLanguage()

function onTarget (next: unknown) {
  const value = String(next ?? '')

  // A select hands back its value on every open as well as on every change, and
  // publishing an unchanged language would write a row into the workspace log
  // for nothing having happened.
  if (value && value !== target.value) setTarget(value)
}

/** Google is not a model: nothing to choose, nothing to think, nothing to bill. */
const usesModel = computed(() => translate.value.engine !== 'google')

const model = computed(() =>
  MODELS.value.find((m) => m.value === translate.value.model) ?? MODELS.value[0]!)

/**
 * Whether the chosen model can be shown the page at all.
 *
 * Not every one on the list can — DeepSeek's whole line is text-only — and the
 * consequence has to be visible here, because it is invisible everywhere else.
 * `translatePage` quietly declines to attach an image a model cannot read, so
 * AI · Image against a text-only model is not an error and produces no warning:
 * it produces an ordinary text translation while the toolbar goes on claiming
 * the artwork was read. That is the exact shape of wrongness this panel exists
 * to prevent, so the engine is refused rather than reinterpreted.
 *
 * Below `model` rather than above it, and it has to be: `watch` reads its
 * source once on registration, so a getter declared up here would touch `model`
 * before its `const` had run.
 */
const canSee = computed(() => !usesModel.value || model.value.vision)

/*
 * Picking a text-only model with AI · Image already on leaves an engine
 * selected that cannot run. Moved rather than left invalid, and moved visibly:
 * the toggle slides one across under the reader's eye and the line below says
 * why, which is the difference between being told and being overruled.
 *
 * `immediate`, because the invalid pair can also *arrive* rather than be
 * picked: the engine and model are remembered on this machine, and a curated
 * model whose `vision` flag has since been corrected to false restores as
 * AI · Image against a model that cannot see. A watch that only fires on
 * change never fires on that — `canSee` starts false and stays false — and
 * every press then ran as a text translation with the picture silently
 * dropped, filed under an engine name claiming the artwork was read.
 */
watch(canSee, (able) => {
  if (!able && translate.value.engine === 'ai-image') translate.value.engine = 'ai-text'
}, { immediate: true })

const effort = computed(() => EFFORTS.find((e) => e.value === translate.value.effort) ?? EFFORTS[0]!)

/**
 * How far along the three settings effort is, which is what the rail draws:
 * each is more of the same thing than the last, so it is a position rather
 * than one of three unrelated choices.
 */
const effortIndex = computed({
  get: () => Math.max(0, EFFORTS.findIndex((item) => item.value === translate.value.effort)),
  set: (at) => {
    const item = EFFORTS[at]

    if (item) translate.value.effort = item.value
  },
})

/**
 * Bound to a list of one, so that picking a model leaves the list open.
 *
 * A combobox that holds a single value closes the moment one is chosen, and
 * that would shut the panel on the very thing the choice reveals — the rail
 * belongs to the row that was just picked, and it would be gone before it
 * could be seen. Holding many keeps it open; holding exactly one keeps it a
 * single choice.
 *
 * Only what has *joined* the list counts. Press the model already chosen and
 * the list comes back empty, with nothing new in it — which is how a choice
 * that must always be made refuses to be unmade.
 */
const picked = computed(() => [translate.value.model])

function onPick (next: unknown) {
  const added = ((next as string[]) ?? []).find((value) => value !== translate.value.model)

  if (added) translate.value.model = added
}

/*
 * What a press would cost is `useTranslate.estimate`, not this panel's.
 *
 * It was worked out here, from a formula of invented coefficients over every
 * non-rubbish block on the page — which costed hidden blocks, blocks the run
 * never sends, and none of the standing instructions that are most of a page
 * prompt. The composable builds the prompt it would actually send and counts
 * that. See the comment there, which lists the four separate ways this was
 * wrong.
 */

/** A segmented control lets go of its value when you press what is already on. */
function pick<T> (next: unknown, current: T): T {
  return (next as T) || current
}

/** How far a chapter-wide run has got, as a percentage — the same shape `Detect` draws. */
const done = computed(() => {
  const at = progress.value

  return at ? Math.round(((at.page - 1) / at.pages) * 100) : 0
})
</script>

<template>
  <!--
    The panel's own container is the field group, carrying the density every
    label and description inside it reads — see `FieldGroup`.
  -->
  <UFieldGroup density="panel">
    <UField>
      <UFieldLabel>Engine</UFieldLabel>
      <UToggleGroup
        type="single"
        variant="outline"
        size="sm"
        class="w-full"
        :model-value="translate.engine"
        @update:model-value="translate.engine = pick($event, translate.engine)"
      >
        <!--
          AI · Image is refused, not merely discouraged, while the chosen model
          is text-only. Left pressable it would run as a plain text translation
          with the picture silently dropped, which is worse than not offering it
          — the reader would be judging the model on a job it was never given.
        -->
        <UToggleGroupItem
          v-for="engine in ENGINES"
          :key="engine.value"
          :value="engine.value"
          :disabled="engine.value === 'ai-image' && !canSee"
          class="aria-pressed:text-primary flex-1"
        >
          {{ engine.label }}
        </UToggleGroupItem>
      </UToggleGroup>

      <p v-if="!canSee" class="text-muted-foreground text-[11px]">
        {{ model.label }} reads text only — it cannot be shown the page. Pick a model that can see
        to use AI · Image.
      </p>
    </UField>

    <!--
      Model and effort in one control because they are one decision: neither
      means anything without the other, and neither means anything at all
      unless the engine is one that thinks. In one list they are also one press
      apart, and the button says where both of them stand without being opened.

      A combobox rather than a pair of pickers: there are three models today and
      there will not be three for long — every provider adds to its list and
      renames what is already on it, and a list you can only walk is one that
      stops being usable at about a dozen. The search reads what is written on
      each row, so it answers to "sonnet" as readily as to the id underneath.
    -->
    <UField>
      <UFieldLabel>Model &amp; effort</UFieldLabel>
      <UCombobox
        multiple
        :model-value="picked"
        :disabled="!usesModel"
        @update:model-value="onPick"
      >
        <UComboboxAnchor as-child>
          <UComboboxTrigger as-child>
            <UButton
              variant="outline"
              size="sm"
              class="w-full justify-between font-normal"
              :disabled="!usesModel"
            >
              <span class="truncate">
                {{ model.label }}
                <span class="text-muted-foreground">· {{ effort.label }}</span>
              </span>
              <ChevronsUpDownIcon class="size-4 shrink-0 opacity-50" />
            </UButton>
          </UComboboxTrigger>
        </UComboboxAnchor>

        <UComboboxList>
          <UComboboxInput placeholder="Search models…" />
          <UComboboxEmpty>Nothing of that name.</UComboboxEmpty>

          <!--
            The chosen model opens into its own effort rail. Effort is a
            property of the model you are asking, not of the panel, so it is
            drawn inside the row it belongs to — and only one row can be open,
            because only one model is chosen.

            The rail is a sibling of the row rather than a child of it: a row
            is an option, options are picked, and putting three more things to
            press inside one would make every press ambiguous. Nesting them in
            one bordered box is what makes them read as a single card.
          -->
          <!--
            `auto-rows-min` is doing real work, not tidying.

            A grid inside a box with a maximum height shares that height out
            among its rows, so eight models in a list capped at eighteen rem got
            a fifth of a row each: the descriptions vanished, the prices slid
            under the labels, and the chosen row's effort rail — the tallest
            thing here — was crushed to nothing. Rows sized to their content
            instead, and the list scrolls when there are more than fit. Three
            models fitted and hid this; the fourth would always have found it.
          -->
          <UComboboxGroup class="grid max-h-64 auto-rows-min gap-0.5 overflow-y-auto p-1">
            <div
              v-for="item in MODELS"
              :key="item.value"
              class="overflow-hidden rounded-md border"
              :class="item.value === translate.model ? 'bg-muted/40 border-border' : 'border-transparent'"
            >
              <!--
                Highlighting a row and choosing it come to the same colour, so
                that running down the list shows you what each row would look
                like once picked rather than flashing a second, louder shade at
                you on the way past.

                The chosen row highlights to nothing at all, because its card
                already carries that colour — laid over itself it would come out
                half again as dark, and the one row you are most likely to be
                pointing at would be the one that did not match.
              -->
              <UComboboxItem
                :value="item.value"
                class="gap-2.5 rounded-md py-2 pr-3 pl-2.5"
                :class="item.value === translate.model
                  ? 'data-highlighted:bg-transparent'
                  : 'data-highlighted:bg-muted/40'"
              >
                <span
                  class="size-1.5 flex-none rounded-full"
                  :class="item.value === translate.model ? 'bg-primary' : 'bg-muted-foreground/40'"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] leading-snug">{{ item.label }}</span>
                  <span class="text-muted-foreground block truncate text-[11px] leading-snug">{{ item.desc }}</span>
                </span>
                <!--
                  What it costs, not what it is set to: the rail below already
                  names the effort, and a row that repeated it would print the
                  same word twice an inch apart. The rate is the one thing that
                  separates these three and cannot be read anywhere else.
                -->
                <span v-if="item.free" class="text-muted-foreground font-mono text-[10px]">free</span>
                <span v-else class="text-muted-foreground font-mono text-[10px]">${{ item.in }}/M</span>
              </UComboboxItem>

              <StepRail
                v-if="item.value === translate.model"
                v-model="effortIndex"
                :steps="EFFORTS.map((step) => step.label)"
                label="Effort"
              >
                {{ effort.desc }}
              </StepRail>
            </div>
          </UComboboxGroup>
        </UComboboxList>
      </UCombobox>

      <p v-if="!usesModel" class="text-muted-foreground text-[11px]">
        Google translates the text as given — there is no model to pick and nothing for it to think about.
      </p>
    </UField>

    <!--
      Only the language being translated *into*. What the page is written in is
      the engine's to work out — every one of the three reads it off the text
      anyway, and a pair of pickers made the reader state something the machine
      already knew, then let them state it wrong.
    -->
    <UField>
      <UFieldLabel>Target language</UFieldLabel>
      <USelect :model-value="target" @update:model-value="onTarget">
        <USelectTrigger size="sm" class="w-full">
          <USelectValue />
        </USelectTrigger>
        <!--
          Under the trigger and its width — see `panel/Detect.vue`, which sets
          out what the default does to a select sitting in a panel field.
        -->
        <USelectContent position="popper" class="w-(--reka-select-trigger-width)">
          <USelectItem v-for="lang in languages" :key="lang.value" :value="lang.value">
            {{ lang.label }}
          </USelectItem>
        </USelectContent>
      </USelect>
    </UField>

    <!--
      Two switches, each with a line saying what it costs. Written out by hand
      this was a label wrapping a span wrapping a span, with the description's
      size picked here and nowhere else — `Field` in its horizontal orientation
      is the same arrangement said once, and it is the arrangement that keeps
      the switch level with the name rather than with the middle of a
      two-line explanation.

      The labels carry `data-density="form"`: these name a control the way a
      form's label does, rather than marking a group the way `Detector` above
      does, so they are not the inspector's ten-pixel caps. The density still
      reaches their descriptions, which is what keeps them at eleven pixels
      instead of the form's fourteen.
    -->
    <UFieldGroup density="panel" class="gap-2">
      <UField orientation="horizontal">
        <UFieldContent>
          <UFieldLabel for="translate-honorifics" data-density="form">Keep honorifics</UFieldLabel>
          <UFieldDescription>Leave -san, -kun and the rest as written</UFieldDescription>
        </UFieldContent>
        <USwitch id="translate-honorifics" v-model="translate.honorifics" />
      </UField>

      <UField orientation="horizontal">
        <UFieldContent>
          <UFieldLabel for="translate-context" data-density="form">Read the page first</UFieldLabel>
          <UFieldDescription>Slower, but a line knows what came before it</UFieldDescription>
        </UFieldContent>
        <USwitch id="translate-context" v-model="translate.context" :disabled="!usesModel" />
      </UField>
    </UFieldGroup>

    <!--
      Counted, not listed. The list moved to its own panel — see `Glossary.vue`,
      which explains why — and what is left here is the one glossary question
      that belongs on this panel: how many terms the next press will send. That
      is also the fault indicator, and the reason the count stayed behind rather
      than going with the list: nought after ten pages means the terms are not
      being learned, which is a real fault with a real cause.
    -->
    <div class="border-border flex items-center justify-between rounded-md border px-2.5 py-1.5">
      <span class="flex items-center gap-2 text-sm">
        <BookMarkedIcon class="text-muted-foreground size-4" />
        Glossary
      </span>
      <span class="text-muted-foreground font-mono text-xs">{{ terms.length }} terms</span>
    </div>

    <!--
      What the models have actually been asked, and what it came to.

      A table rather than the four-line summary this replaced, because the
      question changed. That block answered "what would this press cost", which
      is one number and reads fine as a list; this answers "what has this page
      cost me", which is a running record — and a record wants columns you can
      run your eye down and a total you can trust at the bottom.

      **This page only.** The whole chapter is recorded — see `useAiUsage` — but
      a chapter-long list would put the row you care about at an unpredictable
      depth and total up a question you did not ask. Which is also why the first
      column is the model rather than the page: every row here is the same page,
      and a column repeating its name forty times would be spending the panel's
      only wide column on the one thing already known.

      The estimate has not gone: it is the first row, marked as the prediction it
      is, sitting directly above the calls it is predicting. That is the most
      useful place for it — a reader who has done three pages can see what the
      last three actually cost and what the next one is expected to, in the same
      column, and judge the estimate on its record rather than on our word.

      Rows are the calls, newest first, and they scroll. The total is outside the
      scroll box on purpose: it is the one line that should never be scrolled
      away from, and it counts calls this table has already dropped — see
      `useAiUsage`, which keeps what trimmed rows were worth so the figure
      cannot quietly fall.
    -->
    <!--
      **The columns are one grid, and they have to be.**

      Every row here was its own `grid-cols-[1fr_auto_auto_auto]`, with a comment
      claiming they were "inherited" so the rows would line up. Grid columns are
      not inherited: sibling grids are independent, each sizes its own `auto`
      tracks to its own content, and the four numbers landed at four different
      places on every line. A cost of `—` made its column narrow and shoved that
      row's figures right; a five-digit token count widened another. The table
      read as a heap.

      So the box itself is the grid and every band of it — header, each row, the
      total — is `grid-cols-subgrid` spanning all four. The columns are then
      measured across *all* the rows at once, which is exactly what a `<table>`
      does and the only thing that makes a column of numbers scannable. Subgrid
      rather than fixed widths because a fixed `Model` column would have to be
      sized for "DeepSeek V4 Pro" on every page that never uses it, and this
      panel has no width to spare.
    -->
    <div class="bg-muted/40 border-border grid grid-cols-[1fr_auto_auto_auto] gap-x-2 gap-y-1 rounded-md border px-2.5 py-2 text-xs">
      <template v-if="estimate || total.calls">
        <div class="text-muted-foreground col-span-4 grid grid-cols-subgrid gap-x-2 text-[10px] tracking-wide uppercase">
          <span>Model</span>
          <span class="text-right">In</span>
          <span class="text-right">Out</span>
          <span class="text-right">Cost</span>
        </div>

        <USeparator class="col-span-4 my-0.5" />

        <!--
          Capped in height rather than in rows: two calls should not leave a
          gap, and forty should not push the button off the panel. It is a
          subgrid as well as a scroll box, so the rows inside keep the outer
          columns instead of starting a table of their own halfway down.
        -->
        <div class="col-span-4 grid max-h-40 grid-cols-subgrid gap-y-0.5 overflow-x-hidden overflow-y-auto">
          <!--
            The estimate, in the same columns as the record. Italic and prefixed
            so it cannot be mistaken for something that happened — it is the
            only row here that has not been billed.
          -->
          <div
            v-if="estimate"
            class="text-muted-foreground col-span-4 grid grid-cols-subgrid font-mono tabular-nums"
          >
            <span class="min-w-0 truncate italic">{{ estimate.force ? 'next · again' : 'next' }}</span>
            <span class="text-right">{{ estimate.input.toLocaleString() }}</span>
            <span class="text-right">{{ (estimate.output + estimate.thinking).toLocaleString() }}</span>
            <span class="text-right">~{{ estimate.cost.toFixed(4) }}</span>
          </div>

          <!--
            The same model twice is two real rows — a page put through again
            after a correction — so the time tells them apart on hover, where it
            costs no width.
          -->
          <div
            v-for="use in rows"
            :key="use.at"
            class="col-span-4 grid grid-cols-subgrid font-mono tabular-nums"
            :title="`${use.page} · ${use.model}${use.what ? ` · ${use.what}` : ''} · ${new Date(use.at).toLocaleString()}`"
          >
            <!--
              `min-w-0` on the cell, not only on the text: a grid item's
              automatic minimum is its min-content width, so one long model name
              would size the column to itself and push the cost out of the dock.
              The same rule the panel list rows live by.

              A call that was not the page gets a word saying what it was — see
              `AiUse.what`. In the same cell rather than a fifth column, because
              the table is four columns of figures and a name, and a whole
              column that is blank on most rows would cost width the cost column
              needs. Not truncated with the name: it is two or three letters and
              it is the part that distinguishes two otherwise identical rows, so
              the name gives way to it rather than the other way round.
            -->
            <span class="flex min-w-0 items-baseline gap-1">
              <span class="min-w-0 truncate">{{ use.model }}</span>
              <span v-if="use.what" class="text-muted-foreground shrink-0 text-[10px]">{{ use.what }}</span>
            </span>
            <span class="text-right">{{ use.input.toLocaleString() }}</span>
            <span class="text-right">{{ use.output.toLocaleString() }}</span>
            <!--
              An em dash sits where a figure would, right-aligned with the rest,
              so the column still reads down as a column.
            -->
            <span class="text-right">{{ use.cost === null ? '—' : use.cost.toFixed(4) }}</span>
          </div>
        </div>

        <USeparator class="col-span-4 my-0.5" />

        <div class="col-span-4 grid grid-cols-subgrid font-mono font-medium tabular-nums">
          <!--
            "This page" rather than "Total", because it is one: the chapter has
            a bigger number and this line is not it, and a bare "Total" beside a
            list that happens to be one page's is exactly how somebody reads the
            wrong figure and believes a volume cost four cents.
          -->
          <span class="text-muted-foreground min-w-0 truncate font-sans">
            This page<span v-if="total.calls" class="text-muted-foreground/70"> · {{ total.calls }}</span>
          </span>
          <span class="text-right">{{ total.input.toLocaleString() }}</span>
          <span class="text-right">{{ total.output.toLocaleString() }}</span>
          <!--
            A floor rather than a figure when some call went unpriced, because a
            total that silently omits them is the one number here nobody would
            check. The `$` rides on this line alone: repeated down every row it
            would be four characters of noise in the narrowest column, and the
            heading already says what the column is.
          -->
          <span class="text-right">{{ total.unpriced ? '≥' : '' }}${{ total.cost.toFixed(4) }}</span>
        </div>

        <p v-if="total.reasoning" class="text-muted-foreground col-span-4 text-[10.5px] leading-snug">
          {{ total.reasoning.toLocaleString() }} of those output tokens were thinking.
        </p>

        <!--
          Said out loud while the rates are the built-in ones. A figure to four
          decimal places reads as measured, and until OpenRouter has priced
          *this model* the estimate is arithmetic over numbers this repo made
          up — which is a thing to admit rather than to round prettily. Per
          model, not per fetch: an id the endpoint did not answer for keeps
          its placeholder after every other price has landed, and this line
          with it. Only the estimate is affected: the recorded rows are what
          the provider actually charged.
        -->
        <p v-if="estimate && !estimate.priced" class="text-muted-foreground col-span-4 text-[10.5px] leading-snug">
          The estimate is at built-in rates — OpenRouter has not priced this model yet.
        </p>
      </template>

      <p v-else class="text-muted-foreground col-span-4">
        {{ usesModel ? 'Nothing on this page to put through.' : 'No tokens and no cost — Google is not billed by the word.' }}
      </p>
    </div>

    <!--
      Three things while a run is going, for the reason the Detect panel gives
      at length: where the run is, what it is doing right now, and — the one
      this panel has that reading does not — what it has cost so far. Money
      spent is the fact a reader most wants during a chapter-wide run and the
      one they cannot get anywhere else, so it is shown as it accrues rather
      than reported at the end.
    -->
    <div v-if="progress" class="border-border grid gap-1.5 rounded-md border px-2.5 py-2">
      <div class="flex items-baseline justify-between gap-2 text-[11px]">
        <span class="font-medium">
          Page {{ progress.page }}<span class="text-muted-foreground"> of {{ progress.pages }}</span>
        </span>
        <span class="text-muted-foreground font-mono tabular-nums">{{ done }}%</span>
      </div>

      <!--
        Pulsing while a page is out: the bar counts pages written, so it sits
        still for as long as the model takes over one — a minute, on a slow
        model — and a bar that does not move reads as a run that is not going.
      -->
      <UProgress :model-value="done" :class="{ 'animate-pulse': !stopping }" />

      <p class="text-muted-foreground truncate text-[11px]">
        {{ progress.message }}
      </p>

      <div class="text-muted-foreground flex justify-between gap-2 text-[11px]">
        <span>{{ progress.done }} line{{ progress.done === 1 ? '' : 's' }} so far</span>
        <span v-if="progress.cost !== null" class="font-mono tabular-nums">${{ progress.cost.toFixed(4) }}</span>
      </div>
    </div>

    <p v-else-if="error" class="text-destructive flex items-start gap-1.5 text-[11px]">
      <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0">{{ error }}</span>
    </p>

    <!--
      Said only when there is something to explain: a page that came back
      looking untouched, because its lines were already written. Without it the
      button reads as broken — which is what the earlier build found, and fixed
      with this same sentence.
    -->
    <p v-else-if="kept && !pending" class="text-muted-foreground text-[11px]">
      {{ kept }} line{{ kept === 1 ? '' : 's' }} kept the wording already there. Translate again to
      replace the page, or use Translate on a selected block to replace one.
    </p>

    <!--
      The way out of a run you did not want, offered for as long as it is the
      last thing that happened.

      Worth a button of its own rather than leaving it to the revision list:
      one press writes thirty lines, and undoing it a balloon at a time is a
      chore nobody finishes. Every line goes back to whatever it said before —
      a different wording each, which is why the server does it and not us.

      It is not destructive of anything older: the run's own revisions go, and
      what was underneath comes back exactly as it was, typed lines included.

      Desktop: only where the database keeps the revisions (`shared`) — a
      workspace not moved into it yet has none, and `revertRun` filters out every
      page with no row and reverts nothing, so the web build offers a local
      workspace an undo that silently does not happen.
    -->
    <UButton
      v-if="lastRun && !running && shared"
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground justify-start text-[11px]"
      @click="revertRun"
    >
      <Undo2Icon class="size-3.5" />
      Undo that run — {{ lastRun.lines }} line{{ lastRun.lines === 1 ? '' : 's' }}
      <span v-if="lastRun.pageIds.length > 1">across {{ lastRun.pageIds.length }} pages</span>
    </UButton>

    <!--
      A split button rather than a stack, for the same reason as the Detect
      panel's: one page is the everyday press, the whole chapter is the
      occasional one, and stacking them cost a row of panel for an action used
      once per volume.

      The main button changes what it offers once the page is full, the same way
      `Detect`'s becomes "Read page again". It has to: the ordinary press fills
      in what is missing and cannot overwrite a line, so on a page carried over
      with Google — where nothing is missing — it has nothing to do and greys
      itself out. That left trying the same page against a model as an ask with
      no button, which is what this replaces.

      And the two presses are not the same bargain, so they are not the same
      word. "Translate page" cannot cost you anything you wrote; "again" can.
    -->
    <!--
      Desktop: Stop, where the press was made, for as long as the run goes.
      Before this a chapter-wide press could not be called off short of closing
      the chapter. It asks nothing more; the pages already asked about are
      written as they arrive — see `useTranslate.stop` — which is why it says
      "Stopping…" rather than vanishing at once.
    -->
    <UButton
      v-if="running && stoppable"
      variant="outline"
      size="sm"
      class="w-full"
      :disabled="stopping"
      @click="stop"
    >
      <SquareIcon class="size-3.5 fill-current" />
      {{ stopping ? 'Stopping…' : 'Stop translating' }}
    </UButton>

    <UButtonGroup v-else class="w-full">
      <UButton
        v-if="pending"
        size="sm"
        class="flex-1"
        :disabled="running"
        @click="translateCurrent()"
      >
        <WandSparklesIcon class="size-4" />
        Translate page<span class="font-mono">({{ pending }})</span>
      </UButton>
      <UButton
        v-else
        size="sm"
        class="flex-1"
        :disabled="!canRedo || running"
        @click="translateCurrent(true)"
      >
        <RefreshCwIcon class="size-4" />
        Translate page again
      </UButton>

      <UDropdownMenu>
        <UDropdownMenuTrigger as-child>
          <UButton
            size="sm"
            class="px-2"
            :disabled="!redoPages || running"
            aria-label="More ways to translate"
          >
            <ChevronDownIcon class="size-4" />
          </UButton>
        </UDropdownMenuTrigger>
        <UDropdownMenuContent align="end">
          <UDropdownMenuItem :disabled="!pendingPages || running" @click="translateAll()">
            <WandSparklesIcon class="size-4" />
            Translate {{ pendingPages }} remaining page{{ pendingPages === 1 ? '' : 's' }}
          </UDropdownMenuItem>
          <!--
            The one press in this panel that can undo somebody's afternoon, so
            it says what it will do to rather than only what it will do: every
            line on every page, typed ones included.
          -->
          <UDropdownMenuItem :disabled="!redoPages || running" @click="translateAll(true)">
            <RefreshCwIcon class="size-4" />
            Translate all {{ redoPages }} page{{ redoPages === 1 ? '' : 's' }} again
          </UDropdownMenuItem>
        </UDropdownMenuContent>
      </UDropdownMenu>
    </UButtonGroup>
  </UFieldGroup>
</template>
