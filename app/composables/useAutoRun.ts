/**
 * The whole pipeline on one press: read the page, join what is one balloon,
 * paint out the lettering, carry the words over.
 *
 * Every one of those already has a button, and every one of them is somebody
 * pressing a button and then waiting to press the next. This is the same four
 * stops driven end to end so that a chapter can be started and left — which is
 * the whole ask, and the reason this is an orchestrator and not a fifth engine.
 * It owns no inference, no prompt and no model: it decides *what to run next*
 * and gets out of the way, so a fix to the reader or the translator arrives
 * here for free and there is exactly one place each thing is done.
 *
 * ## Why it drives the pages itself
 *
 * `useOcr`, `useClean` and `useTranslate` each have an "all pages" of their
 * own, and running the four of those in turn would be the obvious shape. It is
 * the wrong one: joining reads `page.value` — `useBlockMerge` acts on the page
 * in front of you and the selection on it — so a chapter-wide join has nowhere
 * to happen. Turning the page and doing all four stops there is the only order
 * that lets the join sit between the reading and the cleaning, where it has to
 * be: a balloon must be one block before its artwork is repaired under it and
 * long before its sentence is sent anywhere.
 *
 * It also leaves one progress to report and one place a stop takes effect,
 * rather than four of each.
 *
 * ## Translating one page while reading the next
 *
 * The four stops ran strictly in turn, which left something idle all the time:
 * the GPU while a page was out being translated, the network while the next one
 * was being read and cleaned. A page cost the sum of the two. Translation is now
 * *handed over* rather than waited for — to one translation run for the whole
 * press (`useTranslate.begin`), which asks about the pages as they arrive, a few
 * at a time, and writes them strictly in page order — and the run turns to the
 * next page while it is out. A page now costs the longer of the two.
 *
 * The translation needs nothing from the stops that follow it on *other*
 * pages: its prompt is the page's own blocks, final once they are read and
 * joined, and the image engine sends the scan rather than the cleaning. What it
 * does need — the glossary each page teaches, in order — the translation run
 * keeps, and says how in its own header.
 *
 * One press is one translation run, so it is also one batch: Undo in the
 * Translate panel takes back every page the press carried over. It used to be a
 * run per page, and Undo offered only the last.
 *
 * ## What a stop cannot do
 *
 * No engine here can be interrupted mid-page. A reading is a worker that has
 * been handed a tensor, a translation is a request that has been paid for; both
 * finish or throw, and neither takes a signal. So `stop` means *at the next
 * stop*, the button says so while it waits, and nothing pretends a page in
 * flight can be called back. A button that claimed otherwise would be a button
 * that lies about the reader's money.
 *
 * Translations already out are one of those: a stop asks for nothing more,
 * lets what is out land, and the run is not over until it has — so nothing it
 * asked for is written after it has said it stopped. What lands is written only
 * onto the reading it was asked about (see `commit` in `useTranslate`), so a
 * page read again in the meantime is left as the new reading found it rather
 * than lettered from the old one.
 *
 * ## Why a refusal ends the run
 *
 * A page that fails rarely fails alone: a missing key, a rate limit, a model
 * that has gone away are all conditions the next page meets identically, and
 * eleven more of the same message is not eleven more pieces of information —
 * it is a bill. So the first refusal ends the run and names the stop it came
 * from, and pressing again after fixing it costs nothing that was already done:
 * a page that has blocks is not read again, a line already carried over is not
 * sent again, and a balloon already joined is not offered for joining.
 */
import type { ComicPage } from './useComic'
import type { TranslateOutcome, TranslateRun } from './useTranslate'

import { balloonsDrawnOn } from '~/composables/useOcr'
import { balloonJudge } from '~/utils/ocr/together'
import { readScanSheet } from '~/utils/paper'

/**
 * The stops, in the only order they make sense in.
 *
 * Sorting is deliberately not among them — see `sortIfRead`. It is not a stop
 * somebody chooses, it is part of having just read a page.
 */
export const AUTO_STEPS = ['read', 'join', 'clean', 'translate'] as const

export type AutoStep = typeof AUTO_STEPS[number]

/** What each stop is called where somebody has to read it. */
export const AUTO_STEP_LABELS: Record<AutoStep, string> = {
  read: 'Read',
  join: 'Join',
  clean: 'Clean',
  translate: 'Translate',
}

interface AutoSettings {
  /** Which stops are in the run. A stop nobody wants is not a stop that runs. */
  steps: Record<AutoStep, boolean>
  /**
   * This page, or a run of pages (`range`) — which is every page until it is
   * narrowed. "Every page" was an option of its own beside "Some pages", and
   * the two were one control said twice: every page is the range at its ends.
   */
  scope: 'page' | 'range'
}

/** A run of pages, one-based and inclusive, as the page counter numbers them. */
export interface AutoRange {
  from: number
  to: number
}

export interface AutoProgress {
  /** One-based, so it reads as "page 3 of 12" without arithmetic. */
  page: number
  pages: number
  /** Which stop is being run on it. */
  step: AutoStep
}

export interface AutoOutcome {
  /** Pages the run got all the way through. */
  pages: number
  /** Balloons made out of loose blocks. */
  joined: number
  /**
   * What it did not do and why, each sentence once however many pages it was
   * true of — "no scan to read" eleven times is one fact about the chapter.
   */
  skipped: string[]
  /** The refusal that ended it, or null. */
  error: string | null
  /** Which stop it came from, so the report can name it rather than guess. */
  failed: AutoStep | null
  /** Whether somebody asked it to stop rather than it running out of pages. */
  stopped: boolean
}

export function useAutoRun () {
  const { pages, page, at, go, epoch, setBlocks, setSelection } = useComic()
  const { direction } = useReadingDirection()
  const { merge } = useBlockMerge()

  const { canRead, readCurrent, error: readError, progress: readProgress } = useOcr()
  const { settings: cleanSettings, canClean, cleanCurrent, error: cleanError, progress: cleanProgress } = useClean()
  const {
    begin,
    pendingOf,
    error: translateError,
    progress: translateProgress,
  } = useTranslate()

  const settings = useState<AutoSettings>('auto-settings', () => ({
    steps: { read: true, join: true, clean: true, translate: true },
    scope: 'page',
  }))

  remember('kemolate:auto', settings, (held) => {
    const next: Partial<AutoSettings> = {}
    const steps = held.steps as Record<string, unknown> | undefined

    if (steps && typeof steps === 'object') {
      // Field by field rather than wholesale: a stop added to this list later
      // must arrive switched on, not missing, in a browser holding an entry
      // written before it existed.
      next.steps = Object.fromEntries(AUTO_STEPS.map((step) => [
        step,
        typeof steps[step] === 'boolean' ? steps[step] : true,
      ])) as Record<AutoStep, boolean>
    }

    // `chapter` is what "Every page" was saved as, before it became the range
    // at its ends — which is where an unnarrowed range starts, so it reads as
    // exactly what it meant.
    if (held.scope === 'page') next.scope = 'page'
    else if (held.scope === 'range' || held.scope === 'chapter') next.scope = 'range'

    return next
  })

  /**
   * Which pages "Pages" means, as the reader narrowed it — or null for all of
   * them, which is also what the All button sets it back to.
   *
   * Null rather than `1…N` written down, so that "all" stays all while a
   * chapter's pages are still arriving and after one is added.
   *
   * Not remembered with the rest of the settings, which are about *how* to run
   * and hold for every chapter: page 12 to 30 is a fact about one chapter, and
   * carried into the next it would be a range nobody chose. Stamped with the
   * `epoch` it was set in for the same reason — this is a `useState`, so it
   * outlives the chapter it was set on, and another one opened in this tab
   * starts on all of its pages.
   */
  const chosenRange = useState<(AutoRange & { epoch: number }) | null>('auto-range', () => null)

  /** The range a press would run, kept inside the chapter as it is now. */
  const range = computed<AutoRange>(() => {
    const last = Math.max(1, pages.value.length)
    const chosen = chosenRange.value?.epoch === epoch.value ? chosenRange.value : null
    const clamp = (value: number) => Math.min(last, Math.max(1, Math.round(value) || 1))
    const from = clamp(chosen?.from ?? 1)
    const to = clamp(chosen?.to ?? last)

    return from <= to ? { from, to } : { from: to, to: from }
  })

  /** Whether the range is the whole chapter — what the All button would set. */
  const everyPage = computed(() => range.value.from === 1 && range.value.to >= pages.value.length)

  /** Narrow the range, or `null` for every page again. */
  function setRange (next: Partial<AutoRange> | null) {
    chosenRange.value = next ? { ...range.value, ...next, epoch: epoch.value } : null
  }

  const progress = useState<AutoProgress | null>('auto-progress', () => null)
  const outcome = useState<AutoOutcome | null>('auto-outcome', () => null)
  const stopping = useState<boolean>('auto-stopping', () => false)

  const running = computed(() => progress.value !== null)

  /**
   * What the stop in force last said about itself.
   *
   * Read off whichever engine is working rather than copied into this file's
   * own progress: they are the ones who know, they already say it in their own
   * panels, and a copy would be a second answer that could disagree with the
   * first. The reading and the cleaning take turns; the translation runs beside
   * them and is last in line, so it speaks when neither of them is — between
   * pages, and at the end while the last of it lands.
   */
  const saying = computed(() =>
    readProgress.value?.message
    ?? cleanProgress.value?.message
    ?? translateProgress.value?.message
    ?? '')

  /** Whether there is anything for a press to do at all. */
  const canRun = computed(() =>
    pages.value.length > 0 && AUTO_STEPS.some((step) => settings.value.steps[step]))

  function setStep (step: AutoStep) {
    settings.value.steps[step] = !settings.value.steps[step]
  }

  function setScope (scope: AutoSettings['scope']) {
    settings.value.scope = scope
  }

  /**
   * Sorting, but only for a page this run has just read.
   *
   * Reading order is a heuristic about a fresh page — see `readingOrder` — and
   * imposing it on a page that already had blocks would quietly undo the one
   * thing the list has always let somebody do by hand: drag a row because the
   * panel is laid out against the grid and the guess came out wrong. A page
   * whose blocks arrived a moment ago from the detector has no such order to
   * lose, so it gets the guess; a page that already had them keeps whatever
   * order it was in, and the join below joins in that order.
   *
   * `useOcr` now orders a reading as it takes it, so on the ordinary path this
   * finds the work already done — `readingOrder` is a total order by
   * construction, so running it twice changes nothing. It stays because *this*
   * is where the rule about which pages may be reordered lives: the sort in
   * `useOcr` applies to blocks it has just made, and this one is the statement
   * that a page the run did not read keeps the order somebody gave it.
   */
  function sortIfRead (target: ComicPage) {
    if (target.blocks.length > 1) {
      setBlocks(target.id, readingOrder(target.blocks, direction.value))
    }
  }

  async function readStop (target: ComicPage, skip: (why: string) => void) {
    // Cheap to press again: a page that has been read is not read again, which
    // is what makes a run that stopped half way worth restarting.
    if (target.blocks.length) return skip('already read')
    if (!canRead.value) return skip('no scan to read')

    await readCurrent()

    if (readError.value) throw new Error(readError.value)

    sortIfRead(target)
  }

  /**
   * Join what the detector split.
   *
   * A detector returns one box per column of vertical text and one per line of
   * horizontal text, so a balloon arrives as several — `balloonGroups` decides
   * which of them are one thing. The groups are worked out once, before any of
   * them is joined: joining replaces its members with a balloon, and the blocks
   * it did not touch keep their ids, so a list made up front stays valid all
   * the way down. Recomputing between joins would be the same answer at more
   * expense, and would have to be defended against the join it had just made.
   */
  async function joinStop (target: ComicPage, skip: (why: string) => void, done: AutoOutcome) {
    // Desktop: the page's own word on each pair before the geometry's — the
    // balloons drawn when it was read, and its outlines where none were. See
    // `balloonJudge`; without it, two touching balloons were joined into one.
    const scan = target.scan
    const together = scan?.width && scan.height
      ? balloonJudge({
          sheet: await readScanSheet(scan).catch(() => null),
          fences: balloonsDrawnOn(target),
          width: scan.width,
          height: scan.height,
        })
      : undefined

    const groups = balloonGroups(target.blocks, direction.value, together)

    if (!groups.length) return skip('nothing to join')

    for (const group of groups) {
      if (stopping.value) break

      setSelection(group.map((block) => block.id))

      const refused = await merge()

      if (refused) throw new Error(refused)

      done.joined += 1
    }

    // The balloons are made; leaving the last one selected would leave the
    // canvas looking like somebody had picked it.
    setSelection([])
  }

  async function cleanStop (skip: (why: string) => void) {
    // Said apart from "nothing to clean", which it would otherwise be
    // indistinguishable from: one means the page was never read, the other
    // means the reader has said their pages arrive cleaned. A run that skipped
    // the step on every page of a chapter should say which of those it was.
    if (!cleanerRuns(cleanSettings.value.model)) return skip('no cleaner chosen')

    if (!canClean.value) return skip('nothing to clean')

    await cleanCurrent()

    if (cleanError.value) throw new Error(cleanError.value)
  }

  /**
   * Hand the page to the press's translation run and go on without waiting for
   * it — see "Translating one page while reading the next". Answers with whether
   * it was handed over, which is whether the page is through only once its
   * translation lands.
   *
   * By the page rather than "the page on screen", which is what it used to ask
   * about: by the time this page's answer is written the run is two pages on.
   */
  function translateStop (
    target: ComicPage,
    index: number,
    skip: (why: string) => void,
    translation: TranslateRun | null,
    landing: Promise<TranslateOutcome | null>[],
  ): boolean {
    // Somebody pressed Translate in its own panel before this press, and that
    // run is still going. The two would be one run writing over the other.
    if (!translation) {
      skip('another translation was already running')

      return false
    }

    if (!pendingOf(target)) {
      skip('nothing left to carry over')

      return false
    }

    landing.push(translation.add(target, index))

    return true
  }

  /**
   * Run the stops that are switched on, over the page or the range of pages.
   *
   * Ends where it got to rather than going back to where it started: a run that
   * stopped early has stopped somewhere for a reason, and the page it stopped on
   * is the one worth looking at.
   */
  async function start () {
    if (running.value || !canRun.value) return

    const targets = settings.value.scope === 'range'
      ? pages.value.slice(range.value.from - 1, range.value.to)
      : (page.value ? [page.value] : [])

    if (!targets.length) return

    // The chapter these pages belong to. One closed mid-run takes its pages
    // with it, and every write after that lands on a page nobody can reach —
    // see `epoch` in `useComic`.
    const started = epoch.value

    const done: AutoOutcome = {
      pages: 0,
      joined: 0,
      skipped: [],
      error: null,
      failed: null,
      stopped: false,
    }

    const skip = (why: string) => {
      if (!done.skipped.includes(why)) done.skipped.push(why)
    }

    stopping.value = false
    outcome.value = null
    progress.value = { page: 1, pages: targets.length, step: AUTO_STEPS[0] }

    // Where the run had got to when it threw. Kept out here because the stop
    // that failed is the most useful half of the message — "no key for the
    // reader" and "no key for the translator" are the same sentence otherwise.
    let where: AutoStep = AUTO_STEPS[0]

    /*
     * One translation run for the whole press — see the header. Opened here and
     * handed pages as they are ready; it asks for the key with the first of
     * them, so a press over a chapter with nothing left to carry over needs
     * none, as it never did.
     */
    const translation = settings.value.steps.translate ? begin(targets.length) : null

    /** Each page handed to it, settling once the page is written or let go. */
    const landing: Promise<TranslateOutcome | null>[] = []

    /*
     * A translation that has ended the run: refused, or said something about a
     * page — lines left empty, a save that did not land — which ended the run
     * when the run waited for it, and still does, at the next stop.
     */
    const translationEnded = () => Boolean(translation && (translation.failed || translateError.value))

    const halted = () => stopping.value || epoch.value !== started || translationEnded()

    try {
      for (const [index, target] of targets.entries()) {
        if (halted()) break

        // By id rather than by the index it had when the run was planned: a
        // page can be removed while a chapter's worth of work is in flight, and
        // the slot it was in now holds its neighbour.
        const to = pages.value.findIndex((candidate) => candidate.id === target.id)

        if (to < 0) continue

        /** Whether every stop switched on was reached, and whether its translation is still to land. */
        let through = true
        let handed = false

        for (const step of AUTO_STEPS) {
          if (!settings.value.steps[step]) continue

          if (halted()) {
            through = false

            break
          }

          where = step

          if (step === 'translate') {
            handed = translateStop(target, index, skip, translation, landing)

            continue
          }

          // Re-asserted before every stop, not once per page. Each stop but the
          // join works on "the page in front of you", so a page turned by hand
          // — or by a peer's sync landing — would silently move the work onto
          // whatever is now on screen.
          if (at.value !== to) go(to)

          progress.value = { page: index + 1, pages: targets.length, step }

          if (step === 'read') await readStop(target, skip)
          else if (step === 'join') await joinStop(target, skip, done)
          else await cleanStop(skip)
        }

        if (through && !handed) done.pages += 1
      }
    } catch (thrown) {
      done.error = thrown instanceof Error ? thrown.message : String(thrown)
      done.failed = where
    } finally {
      if (translation) {
        // Nothing more is asked about once the run has stopped or failed — for
        // whatever reason, the translation's own included; what is already out
        // lands, and the run is not over until it has.
        if (done.error || halted()) translation.stop()

        if (progress.value) progress.value = { ...progress.value, step: 'translate' }

        await translation.close()

        done.pages += (await Promise.all(landing)).filter(Boolean).length

        if (!done.error && translateError.value) {
          done.error = translateError.value
          done.failed = 'translate'
        }
      }

      done.stopped = stopping.value
      progress.value = null
      stopping.value = false
      outcome.value = done
    }
  }

  /** Ask it to stop, which it will at the next stop. See the header. */
  function stop () {
    if (running.value) stopping.value = true
  }

  /** Put the report away, without undoing anything it reports. */
  function dismiss () {
    outcome.value = null
  }

  return {
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
  }
}
