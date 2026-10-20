<script setup lang="ts">
/**
 * The one press that runs the pipeline — read, join, clean, carry over.
 *
 * In the header rather than in a panel because it is the only control in the
 * app that is about *all* of them: every panel owns one stop and says so, and a
 * button that starts four of them from inside the Detect panel would be a
 * fifth thing that panel does. It sits with Undo and the contributors, among
 * the things you do to a chapter rather than the things you set about one.
 *
 * ## Two controls, not one
 *
 * The press runs; the chevron beside it says what running means. That split is
 * deliberate: this is meant to be pressed without being read, and a button that
 * opened a menu first would make the common case — press it, watch it — cost a
 * decision every time. What the menu holds is remembered on this machine, so
 * the decision is made once and the button is a button afterwards.
 *
 * ## While it runs
 *
 * The press turns into what it is doing, and the stop appears beside it. It
 * says *at the next stop* rather than "stopping" once asked, because that is
 * the truth of it — see the header of `useAutoRun`. Nothing here is disabled
 * on the way through except the settings, which cannot be changed mid-run
 * without the run meaning something different half way down.
 */
import { ChevronDownIcon, LoaderCircleIcon, SquareIcon, WandSparklesIcon } from '@lucide/vue'

const {
  settings,
  progress,
  outcome,
  running,
  stopping,
  saying,
  canRun,
  setStep,
  setScope,
  range,
  everyPage,
  setRange,
  start,
  stop,
  dismiss,
} = useAutoRun()

const open = ref(false)

/** Where a press would run, as the tooltip says it. */
const where = computed(() => {
  if (settings.value.scope === 'page') return 'this page'
  if (everyPage.value) return 'every page'

  const { from, to } = range.value

  return from === to ? `page ${from}` : `pages ${from}–${to}`
})

const { pages } = useComic()

/** See the popover's opening focus. */
function focusScope (event: Event) {
  event.preventDefault()
  document.getElementById('auto-scope')?.focus()
}

/**
 * The range as the slider takes it, two thumbs. Reka keeps them in order and
 * inside `min…max` itself, which is the same promise `range` makes.
 */
const span = computed({
  get: () => [range.value.from, range.value.to],
  set: (value: number[] | undefined) => {
    const [from, to] = value ?? []

    if (from && to) setRange({ from, to })
  },
})

/** Which stops are switched on, as a sentence for the closed button. */
const doing = computed(() =>
  AUTO_STEPS.filter((step) => settings.value.steps[step])
    .map((step) => AUTO_STEP_LABELS[step].toLowerCase())
    .join(', '))

/**
 * What the button says while it works.
 *
 * The page count only when there is more than one, because "page 1 of 1" is
 * three words for nothing — on a single page the stop's own name is the whole
 * of what is worth knowing.
 */
const doingNow = computed(() => {
  const now = progress.value

  if (!now) return ''

  const step = AUTO_STEP_LABELS[now.step]

  return now.pages > 1 ? `${step} ${now.page}/${now.pages}` : step
})

/**
 * The report, once. A toast rather than something that stays on screen: it is
 * an answer to a press that has finished, the panels themselves already show
 * what came of it, and the one thing a person does with it is read it.
 */
watch(outcome, (done) => {
  if (!done) return

  const skipped = done.skipped.length ? `Skipped: ${done.skipped.join(', ')}.` : ''
  const joined = done.joined
    ? `${done.joined} ${done.joined === 1 ? 'balloon' : 'balloons'} joined.`
    : ''

  if (done.error) {
    toast.error(`Auto stopped at ${AUTO_STEP_LABELS[done.failed ?? 'read'].toLowerCase()}`, {
      description: done.error,
    })
  } else if (done.stopped) {
    toast(`Stopped after ${done.pages} ${done.pages === 1 ? 'page' : 'pages'}`, {
      description: [joined, skipped].filter(Boolean).join(' ') || undefined,
    })
  } else {
    toast.success(`${done.pages} ${done.pages === 1 ? 'page' : 'pages'} done`, {
      description: [joined, skipped].filter(Boolean).join(' ') || undefined,
    })
  }

  dismiss()
})
</script>

<template>
  <div class="flex flex-none items-center gap-1">
    <UButtonGroup>
      <UTooltip>
        <UTooltipTrigger as-child>
          <UButton
            size="sm"
            :variant="running ? 'secondary' : 'default'"
            :disabled="!canRun || running"
            class="gap-1.5"
            :aria-label="running ? doingNow : 'Run the pipeline on this chapter'"
            @click="start()"
          >
            <LoaderCircleIcon v-if="running" class="size-4 animate-spin" />
            <WandSparklesIcon v-else class="size-4" />
            {{ running ? doingNow : 'Auto' }}
          </UButton>
        </UTooltipTrigger>
        <UTooltipContent>
          <template v-if="running">{{ saying || 'Working…' }}</template>
          <template v-else-if="!canRun">Open a chapter and switch on a stop to run</template>
          <template v-else>
            Runs {{ doing }} on {{ where }}
          </template>
        </UTooltipContent>
      </UTooltip>

      <UPopover v-model:open="open">
        <UPopoverTrigger as-child>
          <UButton
            :variant="running ? 'secondary' : 'default'"
            size="sm"
            :disabled="running"
            class="px-2"
            aria-label="What Auto runs"
          >
            <ChevronDownIcon class="size-4" />
          </UButton>
        </UPopoverTrigger>

        <!--
          `data-density="popover"`, and every stop's explanation behind an
          `InfoTip` beside its name: this was a column of paragraphs around
          four switches, half the height of the window, and each paragraph is
          read once. What stays on screen is what you set.
        -->
        <!--
          Opening focus goes to the first control rather than the first thing
          that can take focus, which is an `InfoTip` — and a tooltip opens on
          focus, so every opening began with an explanation over the popover.
        -->
        <UPopoverContent align="end" class="w-72" @open-auto-focus="focusScope">
          <UFieldGroup data-density="popover">
            <UField>
              <div class="flex items-center gap-1.5">
                <UFieldLabel for="auto-scope">How much</UFieldLabel>
                <InfoTip label="About how much Auto runs">
                  It turns the pages itself, and ends where it got to.
                </InfoTip>
              </div>
              <USelect
                :model-value="settings.scope"
                @update:model-value="setScope($event === 'range' ? 'range' : 'page')"
              >
                <USelectTrigger id="auto-scope" size="sm" class="w-full">
                  <USelectValue />
                </USelectTrigger>
                <USelectContent>
                  <USelectItem value="page">This page</USelectItem>
                  <USelectItem value="range">Pages</USelectItem>
                </USelectContent>
              </USelect>

              <!--
                The pages as the counter in the header numbers them — one-based,
                both ends included — on one slider with a thumb for each end,
                each saying its page while it moves; the bubble sits over the
                select above rather than holding a strip open for itself, as in
                the page picker. The readout under it says the same when nothing
                is moving, and All puts both thumbs back at the ends — which is
                what "Every page" was, when it was an option of its own.
              -->
              <div v-if="settings.scope === 'range'" class="grid gap-1.5 pt-1.5">
                <USlider
                  v-model="span"
                  :min="1"
                  :max="Math.max(1, pages.length)"
                  :step="1"
                  :min-steps-between-thumbs="0"
                  :disabled="pages.length < 2"
                  :label="(value) => String(value)"
                  aria-label="Pages to run"
                />
                <div class="flex items-center justify-between gap-2">
                  <span class="text-muted-foreground text-xs tabular-nums">
                    <template v-if="everyPage">All {{ pages.length }} {{ pages.length === 1 ? 'page' : 'pages' }}</template>
                    <template v-else>
                      {{ range.from === range.to ? `Page ${range.from}` : `Pages ${range.from}–${range.to}` }} of {{ pages.length }}
                    </template>
                  </span>
                  <UButton
                    variant="ghost"
                    size="xs"
                    :disabled="everyPage"
                    @click="setRange(null)"
                  >
                    All
                  </UButton>
                </div>
              </div>
            </UField>

            <UFieldSeparator />

            <!--
              The stops, in the order they run. Each one is exactly the button
              it already is in its own panel, which is why none of them says
              what it does at any length here — the words are the same words,
              and a second explanation is a second thing to keep true.
            -->
            <UFieldSet>
              <div class="flex items-center gap-1.5">
                <UFieldLegend variant="label">What it runs</UFieldLegend>
                <!--
                  Said here rather than only in the tooltip on the stop button,
                  because it is the kind of thing somebody wants to know
                  *before* starting a chapter's worth of work, not while trying
                  to end it.
                -->
                <InfoTip label="About what Auto runs">
                  Each stop uses the settings in its own panel — the reader, the model, the
                  language. Stopping takes effect at the end of the page being worked on.
                </InfoTip>
              </div>

              <UFieldGroup class="gap-2.5">
                <UField v-for="step in AUTO_STEPS" :key="step" orientation="horizontal" class="items-center">
                  <UFieldContent class="flex-row items-center gap-1.5">
                    <UFieldLabel :for="`auto-${step}`">{{ AUTO_STEP_LABELS[step] }}</UFieldLabel>
                    <InfoTip :label="`About ${AUTO_STEP_LABELS[step]}`">
                      <template v-if="step === 'read'">
                        Finds the balloons and reads them, then puts the page in reading order.
                        A page that has been read already is left alone.
                      </template>
                      <template v-else-if="step === 'join'">
                        Joins boxes that are plainly one balloon, so a sentence split into
                        columns is carried over as one.
                      </template>
                      <template v-else-if="step === 'clean'">
                        Paints the lettering out of the artwork underneath.
                      </template>
                      <template v-else>
                        Carries the lines over, keeping any you have typed yourself.
                      </template>
                    </InfoTip>
                  </UFieldContent>
                  <USwitch
                    :id="`auto-${step}`"
                    :model-value="settings.steps[step]"
                    :aria-label="AUTO_STEP_LABELS[step]"
                    @update:model-value="setStep(step)"
                  />
                </UField>
              </UFieldGroup>
            </UFieldSet>
          </UFieldGroup>
        </UPopoverContent>
      </UPopover>
    </UButtonGroup>

    <UTooltip v-if="running">
      <UTooltipTrigger as-child>
        <UButton
          variant="ghost"
          size="icon-sm"
          :disabled="stopping"
          aria-label="Stop"
          @click="stop()"
        >
          <SquareIcon class="size-3.5" :class="!stopping && 'fill-current'" />
        </UButton>
      </UTooltipTrigger>
      <UTooltipContent>
        {{ stopping ? 'Stopping at the end of this page…' : 'Stop at the end of this page' }}
      </UTooltipContent>
    </UTooltip>
  </div>
</template>
