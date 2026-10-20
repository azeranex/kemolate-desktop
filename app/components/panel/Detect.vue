<script setup lang="ts">
/**
 * Getting the lettering off the page and into blocks — the step before
 * anything else on this panel rail can be done.
 *
 * Its own section rather than a button on Blocks, because it is a different
 * kind of thing: Blocks is what was found, this is the finding, and the
 * settings that govern it hold for every page rather than for the row that
 * happens to be selected. The same split as Translate against Text.
 *
 * Two choices, and they are genuinely two. One model finds the boxes and
 * another reads them — the finder is script-agnostic and the reader is not,
 * so a Japanese chapter and a Chinese one differ in the second only. Both
 * run on this machine, which is what makes reading a chapter free and keeps
 * the scans where they were opened.
 */
import { ChevronDownIcon, CloudUploadIcon, EraserIcon, MessageCircleIcon, ScanTextIcon, TriangleAlertIcon } from '@lucide/vue'

import type { Reader } from '~/utils/ocr/readers'

// By hand, so a dev server that is already running picks the new exports up.
import { useModelMachine } from '~/composables/useModelMachine'
import { detectorBytes } from '~/utils/ocr/detectors'
import { readerBytes } from '~/utils/ocr/readers'

const { page, pages, blockPickable, setSelection } = useComic()
const { settings, progress: reported, error, running, canRead, readablePages, readCurrent, readAll, measureBalloons } = useOcr()

/**
 * How often a run's progress is drawn while it is under way, at most.
 *
 * Ten times a second: faster than a sentence can be read and slower than a
 * download can report, and the bar's own transition carries it in between.
 */
const PACED_MS = 100

/**
 * A run's progress as the panel draws it — the real thing, at most once every
 * `PACED_MS` while the run is going.
 *
 * The engines report on every chunk of a model download — transformers.js hands
 * over each read off the network — and the panel is one template, so every
 * chunk ran all of it again to move a bar by a fraction of a percent and a
 * number by one. On the test chapter a 400-chunk download cost 48 ms of that as
 * the page first loaded, and 2.3 s where development had mounted the panel
 * without the compiler's shortcuts and drew both selects, the switch and the
 * buttons again with it. Nobody reads a figure at that rate.
 *
 * A run starting or stopping is drawn at once. Held back, a finished run would
 * stand on screen for a moment looking unfinished — and the buttons already
 * answer to `running`, which follows the real thing, so they would disagree.
 * In between, the latest report is drawn when the interval is up; nothing is
 * dropped that would still be on screen, only the ones that would have been
 * replaced before anybody saw them.
 */
function paced<T> (source: Ref<T | null>): Readonly<Ref<T | null>> {
  const shown = shallowRef(source.value)
  let last = 0
  let waiting: ReturnType<typeof setTimeout> | undefined

  const show = (value: T | null) => {
    clearTimeout(waiting)
    waiting = undefined
    last = performance.now()
    shown.value = value
  }

  watch(source, (now) => {
    const since = performance.now() - last

    if (now === null || shown.value === null || since >= PACED_MS) {
      show(now)

      return
    }

    waiting ??= setTimeout(() => show(source.value), PACED_MS - since)
  })

  onScopeDispose(() => clearTimeout(waiting))

  return shown
}

const progress = paced(reported)

/**
 * Measuring the balloons of pages read before rooms existed — see
 * `measureBalloons`. Beside reading because it needs the detector and the
 * scans, and in the menu rather than on a button because it is done once per
 * chapter; a reading taken from now on measures as it goes.
 *
 * What it came to is said once and kept until the next run, since the only
 * other sign is lettering that has moved — which is the thing to go and look at.
 */
const measured = ref<{ blocks: number, pages: number } | null>(null)

async function measure (all: boolean) {
  const targets = all
    ? pages.value.filter((candidate) => candidate.scan)
    : [page.value].filter((candidate): candidate is ComicPage => Boolean(candidate?.scan))
  const blocks = await measureBalloons(targets)

  measured.value = blocks === null ? null : { blocks, pages: targets.length }
}

/**
 * Cleaning sits under reading because it comes after it: the boxes have to
 * exist before the lettering inside them can be painted out. Its own model
 * choice, because the model that finds words and the model that removes them
 * are unrelated.
 */
const {
  settings: cleanSettings,
  progress: cleanReported,
  error: cleanError,
  running: cleaning,
  canClean,
  cleanCurrent,
  repairs,
  skipped,
} = useClean()

/** A clean downloads its model too, a chunk at a time — paced the same way. */
const cleanProgress = paced(cleanReported)

/**
 * The six builds as one list, grouped by the model they are builds of.
 *
 * One choice made in one place, which is what a reader actually has in mind —
 * "the heavy comic one" — rather than two controls to set in the right order.
 * Asked as two, choosing a family first put a build nobody had picked into
 * force on the way past, and the second control changed its meaning under
 * you: the same three positions stood for different models depending on what
 * the first one said.
 *
 * Grouped rather than flattened, because the two axes are still not the same
 * axis. A family is a model and a build is one export of it, so `Small` under
 * one heading and `Small` under the other are unrelated; the heading carries
 * what its family answers in, which is the sentence that actually decides
 * between them, and the rows under it differ only by weight.
 */
const FAMILY_LIST = (Object.keys(FAMILIES) as FamilyId[]).map((id) => ({ id, ...FAMILIES[id] }))

const build = computed(() => DETECTORS_BY_ID.get(settings.value.detector))

const reader = computed(() => READERS_BY_ID.get(settings.value.reader))

/** Which builds this browser will fetch — see `useModelMachine`. */
const machine = useModelMachine()

/** A reader's first download on this machine, as sizes are written everywhere, or nothing where it fetches nothing. */
function sizeOf (item: Reader): string | null {
  const bytes = readerBytes(item, machine.value)

  return bytes ? formatBytes(bytes) : null
}

/** A reader that finds its own lettering leaves the detector nothing to do. */
const detects = computed(() => Boolean(reader.value?.detects))

/** What is already on the page, so the button can say what it would replace. */
const found = computed(() => page.value?.blocks.length ?? 0)

/**
 * How far the whole run has got, as a percentage.
 *
 * The pages done, plus however far into the current one the engine has said
 * it is. Without that second term the bar sits still for the whole of a
 * single-page run — which is the commonest run there is, and the one where
 * the first hundred-megabyte download happens.
 */
/** How far a run has got: pages done, plus how far into the current one. */
function share (run: { page: number, pages: number, step?: { done: number, total: number } } | null) {
  if (!run) return 0

  const step = run.step && run.step.total > 0 ? run.step.done / run.step.total : 0

  return Math.min(100, Math.round(((run.page - 1 + step) / run.pages) * 100))
}

const done = computed(() => share(progress.value))
const cleanDone = computed(() => share(cleanProgress.value))

const cleaner = computed(() => CLEANERS.find((item) => item.id === cleanSettings.value.model))

/**
 * Enough of a block's own words to recognise it by on the page.
 *
 * Cut here as well as clipped in CSS. A row that only ellipsized still carried
 * the whole reading as its layout width, and the point of the snippet is to
 * *name* the block — the sentence underneath it is the part worth reading, and
 * a balloon's worth of source above it would be the loudest thing in the box.
 */
const SNIPPET = 36

/**
 * What the last clean could not mask, on the page in front of you.
 *
 * Narrowed to this page on purpose. Cleaning the chapter is one press, so a run
 * can skip a block on thirty pages at once, and a list that showed all of them
 * would bury the two that are actually on screen under twenty-eight that are
 * not — the rest are counted in a single line instead.
 *
 * A block deleted since the run is dropped rather than shown greyed. The whole
 * worth of a row is that pressing it takes you to the thing that failed, and
 * there is no longer anything to be taken to; its position in the list, which
 * is half of how a row names its block, has also stopped meaning anything.
 */
const unmasked = computed(() => {
  const here = page.value

  if (!here) return []

  return skipped.value
    .filter((item) => item.pageId === here.id)
    .map((item) => {
      const at = here.blocks.findIndex((block) => block.id === item.blockId)
      const block = here.blocks[at]
      const source = block?.source.trim() ?? ''

      // `at` is the position the Blocks panel numbers this row by, so the two
      // lists call the same block the same thing — a number that agreed with
      // nothing would be worse than no number.
      //
      // `pickable` is asked here because `setSelection` refuses a block on a
      // hidden or locked layer *silently*: the row would look like the way out
      // and then do nothing when pressed, which is the same complaint this
      // whole box exists to answer.
      return {
        ...item,
        at,
        pickable: Boolean(block && blockPickable(block)),
        snippet: source.length > SNIPPET ? `${source.slice(0, SNIPPET)}…` : source,
      }
    })
    .filter((item) => item.at >= 0)
})

/** The same news about pages you are not looking at, as a count and no rows. */
const unmaskedAway = computed(() =>
  skipped.value.filter((item) => item.pageId !== page.value?.id).length,
)

/**
 * What the warning is about, counted.
 *
 * The rows plus the ones elsewhere rather than `skipped.length`, so the number
 * in the sentence and the number of things the panel can actually account for
 * are the same one — a block deleted since the run is out of both.
 */
const unmaskedTotal = computed(() => unmasked.value.length + unmaskedAway.value)
</script>

<template>
  <!--
    The panel's own container *is* the field group, carrying the density that
    every label and description inside it reads — see `FieldGroup` and the
    `[data-density]` rules in `assets/css/tailwind.css`. The structure is the
    same one the sign-in page uses; only the type is the inspector's.
  -->
  <UFieldGroup density="panel">
    <!--
      The reader is a list rather than a rail: there are several and there will
      be more, and unlike the detector's builds they are not points on one
      scale — a PP-OCRv6 tier and the Korean model are different decisions
      wearing the same shape. Each row carries its own sentence for that
      reason: the trade is not guessable from a name, and the name is all a
      collapsed dropdown ever shows.
    -->
    <UField>
      <UFieldLabel>Reader</UFieldLabel>
      <USelect
        :model-value="settings.reader"
        :disabled="running"
        @update:model-value="settings.reader = pick($event, settings.reader)"
      >
        <USelectTrigger size="sm" class="w-full">
          <!--
            Given its own text rather than left to default. `SelectValue` falls
            back to the selected item's `textContent`, and an item that carries
            a size and a sentence as well as a name has all three as its text —
            so the closed control read "Manga OCR200 MBJapanese, vertical or
            horizontal". The row below is for choosing with; this is for
            saying what was chosen.
          -->
          <USelectValue>{{ reader?.label ?? 'Pick a reader' }}</USelectValue>
        </USelectTrigger>
        <!--
          The list is the field's own width, and both halves of that are
          deliberate.

          `popper` rather than the default `item-aligned`, which is the native
          select's trick of laying the chosen row over the control it came
          from: it hangs the list wherever that row happens to be, so a panel
          field opened a box shifted up and to the left of itself. Under the
          trigger is where a reader looks for it.

          The width then follows the trigger rather than the rows. Sized to
          its own content it took whatever a two-line note wanted — capped at
          `max-w-76`, which in a dock column wider than that came out
          *narrower* than the control that opened it and read as a misaligned
          box rather than a considered one. See `Translate.vue`, which has the
          same on its target language.
        -->
        <USelectContent position="popper" class="w-(--reka-select-trigger-width)">
          <!--
            `text-value` for the same reason, on the other end: it is what
            typing jumps by, and without it a search would match the notes.
          -->
          <USelectItem
            v-for="item in READERS"
            :key="item.id"
            :value="item.id"
            :text-value="item.label"
            class="items-start py-2 *:[span]:last:flex-1"
          >
            <!--
              The two width classes here and on the row are what put the
              megabytes on one right-hand edge.

              A `SelectItem` makes its last span a flex row — see
              `*:[span]:last:flex` in `ui/select/SelectItem.vue` — and that
              span is the one reka wraps the label in. Left alone it is a flex
              child sized to its own content, so the `justify-between` below
              spanned the width of the *text* rather than the width of the
              row, and each size sat wherever its own sentence happened to
              end: a ragged column of numbers down the middle of the list.
              `flex-1` fills the row, `w-full` passes that on to the grid.
            -->
            <span class="grid w-full min-w-0 gap-0.5">
              <span class="flex items-baseline justify-between gap-2">
                <span>{{ item.label }}</span>
                <span v-if="sizeOf(item)" class="text-muted-foreground shrink-0 text-[10px] tabular-nums">{{ sizeOf(item) }}</span>
              </span>
              <span class="text-muted-foreground text-[11px] leading-snug text-pretty">{{ item.note }}</span>
            </span>
          </USelectItem>
        </USelectContent>
      </USelect>
      <p v-if="reader && sizeOf(reader)" class="text-muted-foreground text-[11px]">
        About {{ sizeOf(reader) }} the first time, then kept on this machine.
      </p>
    </UField>

    <!--
      Hidden rather than disabled when the reader finds its own lettering: a
      greyed-out control invites a press and then refuses it, where nothing
      at all says plainly that there is no choice to make here.

      Second, because it is the lesser question and sometimes not a question
      at all: the reader is what a chapter's script decides, and four of the
      seven answer this one themselves.
    -->
    <UField v-if="!detects">
      <UFieldLabel>Detector</UFieldLabel>
      <USelect
        :model-value="settings.detector"
        :disabled="running"
        @update:model-value="settings.detector = pick($event, settings.detector)"
      >
        <USelectTrigger size="sm" class="w-full">
          <!--
            Its own text, for the reason the reader's trigger gives — and the
            *full* name, because the row says "Small", which only means
            anything under the heading it is sitting below. Closed, there is
            no heading.
          -->
          <USelectValue>{{ build ? fullLabel(build.id) : 'Pick a detector' }}</USelectValue>
        </USelectTrigger>
        <!-- Under the trigger and its width, for the reasons the reader gives. -->
        <USelectContent position="popper" class="w-(--reka-select-trigger-width)">
          <USelectGroup v-for="item in FAMILY_LIST" :key="item.id">
            <!--
              The heading is doing the work the family control used to: what
              this model answers in, which is the only thing that separates
              the two and cannot be guessed from a version number.
            -->
            <USelectLabel class="grid gap-0.5 py-1.5">
              <span>{{ item.label }}</span>
              <span class="text-muted-foreground text-[11px] leading-snug font-normal text-pretty">{{ item.note }}</span>
            </USelectLabel>
            <USelectItem
              v-for="option in buildsOf(item.id)"
              :key="option.id"
              :value="option.id"
              :text-value="fullLabel(option.id)"
              class="items-start py-2 *:[span]:last:flex-1"
            >
              <!-- Both widths for the reason the reader's rows give above. -->
              <span class="grid w-full min-w-0 gap-0.5">
                <span class="flex items-baseline justify-between gap-2">
                  <span>{{ option.label }}</span>
                  <span class="text-muted-foreground shrink-0 text-[10px] tabular-nums">{{ formatBytes(detectorBytes(option, machine)) }}</span>
                </span>
                <span class="text-muted-foreground text-[11px] leading-snug text-pretty">{{ option.note }}</span>
              </span>
            </USelectItem>
          </USelectGroup>
        </USelectContent>
      </USelect>
      <UFieldDescription>
        <template v-if="build">
          {{ build.note }} · about {{ formatBytes(detectorBytes(build, machine)) }} the first time
        </template>
      </UFieldDescription>
    </UField>

    <!--
      Said plainly, and only for the reader it is true of. Every other engine
      here runs on this machine and the scans stay where they were opened;
      this one is a page sent to Google, on the reader's own key. That is a
      fair trade for a script nothing local reads — but it is theirs to make
      knowingly rather than by picking a name off a list.
    -->
    <p
      v-if="reader?.provider"
      class="border-border text-muted-foreground flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px]"
    >
      <CloudUploadIcon class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0">Sends each page to Google, on your own key. Every other reader stays on this machine.</span>
    </p>

    <!--
      Three things, because a run raises three different questions and the
      answers move at different speeds: where the run is (the pages line),
      what it is doing right now (the engine's own sentence, which is the one
      that tells you a download is happening rather than a hang), and whether
      it is finding anything (the count, which is the only one that says the
      settings were right).
    -->
    <div v-if="progress" class="border-border grid gap-1.5 rounded-md border px-2.5 py-2">
      <div class="flex items-baseline justify-between gap-2 text-[11px]">
        <span class="font-medium">
          Page {{ progress.page }}<span class="text-muted-foreground"> of {{ progress.pages }}</span>
        </span>
        <span class="text-muted-foreground font-mono tabular-nums">{{ done }}%</span>
      </div>

      <UProgress :model-value="done" />

      <p class="text-muted-foreground truncate text-[11px]">
        {{ progress.message }}
      </p>

      <p v-if="progress.found" class="text-muted-foreground text-[11px]">
        {{ progress.found }} block{{ progress.found === 1 ? '' : 's' }} so far
      </p>
    </div>

    <p v-else-if="error" class="text-destructive flex items-start gap-1.5 text-[11px]">
      <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0">{{ error }}</span>
    </p>

    <p v-else-if="!canRead" class="text-muted-foreground text-[11px]">
      {{ pages.length ? 'This page has no scan on this machine to read.' : 'Open a chapter first.' }}
    </p>

    <p v-else-if="found" class="text-muted-foreground text-[11px]">
      {{ found }} block{{ found === 1 ? '' : 's' }} on this page. Reading it again replaces them.
    </p>

    <!--
      A split button rather than a stack: the page is the action people press
      all day and the whole chapter is the one they press once, so the second
      earns a menu entry rather than a full-height row of its own.
    -->
    <UButtonGroup class="w-full">
      <UButton size="sm" class="flex-1" :disabled="!canRead || running" @click="readCurrent">
        <ScanTextIcon class="size-4" />
        {{ found ? 'Read page again' : 'Read page' }}
      </UButton>
      <UDropdownMenu>
        <UDropdownMenuTrigger as-child>
          <UButton size="sm" class="px-2" aria-label="More ways to read" :disabled="!canRead || running">
            <ChevronDownIcon class="size-4" />
          </UButton>
        </UDropdownMenuTrigger>
        <UDropdownMenuContent align="end">
          <UDropdownMenuItem :disabled="!readablePages || running" @click="readAll">
            <ScanTextIcon class="size-4" />
            Read all {{ readablePages }} page{{ readablePages === 1 ? '' : 's' }}
          </UDropdownMenuItem>
          <UDropdownMenuSeparator />
          <UDropdownMenuItem :disabled="!found || running" @click="measure(false)">
            <MessageCircleIcon class="size-4" />
            Measure balloons on this page
          </UDropdownMenuItem>
          <UDropdownMenuItem :disabled="!readablePages || running" @click="measure(true)">
            <MessageCircleIcon class="size-4" />
            Measure balloons on all {{ readablePages }} page{{ readablePages === 1 ? '' : 's' }}
          </UDropdownMenuItem>
        </UDropdownMenuContent>
      </UDropdownMenu>
    </UButtonGroup>

    <p v-if="measured" class="text-muted-foreground text-[11px]">
      {{ measured.blocks }} block{{ measured.blocks === 1 ? '' : 's' }} on {{ measured.pages }} page{{ measured.pages === 1 ? '' : 's' }}
      now letter into {{ measured.blocks === 1 ? 'its' : 'their' }} balloon. A frame placed by hand still wins.
    </p>

    <USeparator />

    <!--
      Cleaning: the same page, with the lettering painted out. Under reading
      because it needs what reading found — there is nothing to paint out
      until something has said where the words are.
    -->
    <UField>
      <UFieldLabel>Cleaner</UFieldLabel>
      <USelect
        :model-value="cleanSettings.model"
        :disabled="cleaning"
        @update:model-value="cleanSettings.model = pick($event, cleanSettings.model)"
      >
        <USelectTrigger size="sm" class="w-full">
          <USelectValue />
        </USelectTrigger>
        <!-- Under the trigger and its width, for the reasons the reader gives. -->
        <USelectContent position="popper" class="w-(--reka-select-trigger-width)">
          <USelectItem v-for="item in CLEANERS" :key="item.id" :value="item.id">
            {{ item.label }}
          </USelectItem>
        </USelectContent>
      </USelect>
      <!--
        The size is only said where there is one. "None" fetches nothing, and
        "about undefined MB the first time" is the shape a template takes when a
        list grows a member that is not like the others.
      -->
      <UFieldDescription>
        {{ cleaner?.note }}<template v-if="cleaner?.bytes"> · about {{ formatBytes(cleaner.bytes) }} the first time</template>
      </UFieldDescription>
    </UField>

    <!--
      How the hole is decided, which is the other half of a repair and until
      now was not a choice at all.

      Beside the cleaner rather than in a settings dialog on purpose: the model
      above decides what is painted *into* the hole and this decides where the
      hole is, so the two are one question asked twice. Moved out of here it
      would read as a preference about the app, and it is a property of the
      repair — which is exactly what a reader is looking at when a title comes
      back as a black blob.

      Named for what it gets you rather than for what it is. The reader is
      choosing a quality of mask, not a model architecture; "learned" against
      "by brightness" is the whole of what they need to weigh, and the sentence
      under it says when that difference actually shows.

      Off by default and left to be asked for, because both costs are real: a
      model to fetch the first time, and a pass over the whole page instead of
      the balloon in front of you.

      `min-w-0` on the content column, not only on the text. The column is
      `flex-1` in the row, and a flex item's automatic minimum is its
      min-content width — a long unbroken run in the description would
      otherwise size the whole dock column to itself and push the switch off
      its edge. The same note, paid for the same way, sits on the rows below.

      Disabled while a clean is running, matching the cleaner select above:
      changing how the mask is made halfway through means the run painted two
      different things and the progress bar is counting them as one.

      `data-density="form"` on the label, as the Translate panel's switches
      have it and for the reason given there: this names a control the way a
      form's label does, where `Cleaner` above marks the group a control sits
      in. Without it the switch's name came out as the inspector's ten-pixel
      grey caps — the same treatment as the markers over the two selects — so
      the one row here you can act on directly read as another heading.
    -->
    <UField orientation="horizontal">
      <!-- The why behind an `InfoTip`: it was five lines under one switch. -->
      <UFieldContent class="min-w-0 flex-row items-center gap-1.5">
        <UFieldLabel for="clean-segmenter" data-density="form">Learned mask</UFieldLabel>
        <InfoTip label="About Learned mask">
          Marks the lettering with a manga-trained model instead of by brightness. Better on
          bold titles and on text over dark fills, where a threshold inverts and the repair
          comes back a blot. Downloads the first time, and reads the whole page rather than
          each balloon.
        </InfoTip>
      </UFieldContent>
      <USwitch
        id="clean-segmenter"
        v-model="cleanSettings.segmenter"
        :disabled="cleaning || !repairs"
        aria-label="Mark the lettering with a manga-trained model"
      />
    </UField>

    <div v-if="cleanProgress" class="border-border grid gap-1.5 rounded-md border px-2.5 py-2">
      <div class="flex items-baseline justify-between gap-2 text-[11px]">
        <span class="font-medium">
          Page {{ cleanProgress.page }}<span class="text-muted-foreground"> of {{ cleanProgress.pages }}</span>
        </span>
        <span class="text-muted-foreground font-mono tabular-nums">{{ cleanDone }}%</span>
      </div>

      <UProgress :model-value="cleanDone" />

      <p class="text-muted-foreground truncate text-[11px]">
        {{ cleanProgress.message }}
      </p>
    </div>

    <p v-else-if="cleanError" class="text-destructive flex items-start gap-1.5 text-[11px]">
      <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0">{{ cleanError }}</span>
    </p>

    <!--
      Before "read the page first", because it is the earlier objection: with no
      cleaner chosen, reading the page would not make the button work either.
      Both are here so that a disabled button always says why — the state this
      replaces was a grey button and no sentence anywhere.
    -->
    <p v-else-if="!repairs" class="text-muted-foreground text-[11px]">
      No cleaner chosen — pages are left as they came. Place a clean page as a layer, or pick
      a cleaner above.
    </p>

    <p v-else-if="!found" class="text-muted-foreground text-[11px]">
      Read the page first — cleaning works on the blocks that were found.
    </p>

    <UButton
      variant="secondary"
      size="sm"
      :disabled="!canClean || cleaning || running"
      @click="cleanCurrent"
    >
      <EraserIcon class="size-4" />
      Clean page
    </UButton>

    <!--
      What the last run could not paint out, and why.

      News about a run rather than a section of the panel, so it is not here
      until there is something to say and goes as soon as the next run starts —
      which is why nothing below is a heading and there is no empty state. What
      it replaces is a `console.warn`: the block simply refused to clean, looked
      identical to one that had nothing to clean, and the only way to find out
      which was to open a devtools panel nobody has open.

      A warning and not an error. The run itself finished, every other block on
      the page is repaired, and the destructive tone above belongs to the case
      where none of that is true — so this is the bordered notice the Google
      reader uses, in the panel's ordinary type.
    -->
    <div v-if="unmaskedTotal" class="border-border grid gap-1.5 rounded-md border px-2.5 py-2">
      <p class="flex items-start gap-1.5 text-[11px] font-medium">
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0">
          {{ unmaskedTotal }} block{{ unmaskedTotal === 1 ? '' : 's' }} could not be masked, and
          {{ unmaskedTotal === 1 ? 'was' : 'were' }} left uncleaned.
        </span>
      </p>

      <!--
        Each row selects the block it names, which is the whole point of
        listing them: a complaint you can press turns into a way out, because
        the advice at the end of every sentence — narrow the block, paint the
        mask — is something you do to the block once it is selected.

        `min-w-0` on the row itself and not only on the text inside it. A
        grid item's automatic minimum is its min-content width, and `why` is a
        long unbroken sentence, so the row would otherwise size the whole dock
        column to itself and push the panel's controls off the edge. See the
        same note, paid for the same way, on the Blocks panel's rows.

        A row whose block cannot be picked stops looking pressable and says
        why, and that is *all* it does — the Blocks panel greys such a row out,
        and greying this one turned the reason unreadable. The two lists are
        showing different things: over there the row is a handle on a block, so
        a handle you cannot take hold of should look like one; here the row is
        a sentence to be read, and the reading has to survive the layer being
        shut. Which is not academic, and worse than it sounds: the Clean preset
        hides *and* locks Dialogue, so the state you are in when you press
        "Clean page" is precisely the one where none of these blocks can be
        picked — every row in this box would have been at 40 per cent, and the
        reason with it. So the press is refused there and the row says how to
        get it back, rather than the box going quiet at the one moment it is
        being read.
      -->
      <button
        v-for="item in unmasked"
        :key="item.blockId"
        type="button"
        class="-mx-1 flex min-w-0 items-start gap-1.5 rounded-sm p-1 text-left"
        :class="item.pickable ? 'hover:bg-accent' : 'cursor-not-allowed'"
        :aria-disabled="!item.pickable"
        :title="item.pickable ? undefined : 'On a layer that is hidden or locked — show and unlock it to pick this block'"
        @click="item.pickable && setSelection([item.blockId], item.blockId)"
      >
        <span class="text-muted-foreground mt-px flex size-4 flex-none items-center justify-center font-mono text-[10px] tabular-nums">
          {{ item.at + 1 }}
        </span>
        <span class="grid min-w-0 gap-0.5">
          <!--
            The reading, or a plain admission where there is none — a blank
            line would read as a row about nothing rather than a block the
            reader found no words in.
          -->
          <span class="truncate text-[11px]" :class="!item.snippet && 'text-muted-foreground italic'">
            {{ item.snippet || 'No text read' }}
          </span>
          <!--
            The sentence exactly as the cleaner wrote it. It already ends in
            what to do about it, and shortening it here would take that off.
          -->
          <span class="text-muted-foreground text-[11px] leading-snug text-pretty">{{ item.why }}</span>
        </span>
      </button>

      <!--
        Cleaning the chapter is one press, so the run that reports this may have
        been about pages that are not on screen. Said, because a count of nought
        rows under a warning about forty blocks reads as a bug in the panel.
      -->
      <p v-if="unmaskedAway" class="text-muted-foreground text-[11px]">
        <template v-if="unmasked.length">And {{ unmaskedAway }} more on other pages.</template>
        <template v-else>All of them are on other pages.</template>
      </p>
    </div>
  </UFieldGroup>
</template>
