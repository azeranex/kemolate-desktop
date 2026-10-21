/**
 * Carrying the lettering of the open chapter into another language.
 *
 * The seam between the engines — `utils/google.ts` and `utils/openrouter.ts`,
 * neither of which knows what a workspace is — and the comic. `useOcr` is the
 * same shape one stage earlier and this deliberately reads like it: one run at
 * a time, a progress line, an epoch guard, and the results written back through
 * the one door that files them on the timeline.
 *
 * Everything happens in this browser, on the reader's own key. That is the same
 * promise the rest of the pipeline makes and here it has teeth: the AI · Image
 * engine sends the *page* to the model, so routing it through our server would
 * be uploading every scan after all, by a different door.
 *
 * ## What a press actually asks for
 *
 * "Translate page" fills in the lines that have none. It does not overwrite a
 * line somebody typed, and that asymmetry is the whole of the button's
 * behaviour: a translator's own wording is the most valuable thing on the page,
 * and a run that quietly replaced it would be the one mistake this app cannot
 * apologise for. Wanting the model's answer instead is a different ask, and it
 * has a different button — see `translateBlock`.
 *
 * The model is nonetheless shown the *whole* page, already-translated lines and
 * all, because a comic's lines lean on each other: `怎...` alone reads as a
 * standalone "what?", but beside the `怎麼可以......` it breaks off from it is
 * the "H—" of "How could I...". The answers for lines that already had one are
 * read and thrown away. That is the "Read the page first" switch, and what it
 * costs is a few hundred tokens of input against a page that reads as one
 * conversation instead of as a column of unrelated sentences.
 *
 * ## What is never sent
 *
 * Blocks the reader has hidden or marked as rubbish, blocks with nothing in
 * them, and — the one that saves real money — blocks that are already in the
 * target's script on a page written in another. A logo, a rating stamp, a bare
 * "!?" comes back as itself; see `shared/utils/lang.ts` for how that is judged
 * without asking anybody.
 *
 * ## Three pages out at once, written one at a time
 *
 * A run used to ask about a page, wait the ten or sixty seconds a model takes,
 * write it, and only then ask about the next — so a chapter cost the sum of
 * every page's wait, with the network idle between each. It now keeps up to
 * `IN_FLIGHT` pages asked and unwritten at once, and writes them strictly in
 * page order: page six's answer, however early it comes back, waits for page
 * five's to be written first.
 *
 * The order is not tidiness. The glossary and the cast grow a page at a time
 * and each page is prompted with what the pages before it settled — first
 * translation wins — so what page five teaches has to be learned before page
 * six's words are written, or the two could disagree about a name. Writing in
 * order keeps the *list* exactly what a one-at-a-time run would have built.
 * What it cannot do alone is make page six, asked before page five answered,
 * agree with a name it was never told; `askAgain` decides when it might not, and
 * that page is asked again, once, with the list as it now stands. A run that
 * keeps having to do that is in a stretch of the chapter still introducing
 * itself, and goes back to one page at a time until it is through it.
 *
 * The rest is what one run at a time always promised, kept per page:
 *
 * - **Nothing is written half.** A page's lines, their save and what it taught
 *   land together in `commit`, or not at all. A refusal ends the run where it
 *   happened: the pages before it are written, and the pages asked after it —
 *   paid for, and answered without whatever the refused page would have
 *   settled — are let go rather than written out of order. So is everything
 *   still out when the chapter closes or the target language changes.
 * - **An answer is written onto the reading it was asked about, or nowhere.**
 *   See `commit`, and the auto run, which is now reading the next page while
 *   this one is out and so gave that question somewhere to happen.
 * - **One batch.** The run mints one name for every page it writes, so "Undo"
 *   still takes back the whole press, as it did.
 *
 * Google is asked a page at a time still: it already asks eight lines of a page
 * at once, it is an undocumented endpoint that rate-limits by browser, and it
 * keeps no glossary for pages to disagree about.
 */
import { askAgain } from '#shared/utils/glossary'
import { rowOf } from '~/utils/ocr/blocks'

/** How far along a run is, and what it has spent getting there. */
export interface TranslateProgress {
  /** One-based, so it reads as "page 3 of 33" without arithmetic. */
  page: number
  pages: number
  message: string
  /** Lines carried over so far in this run, over every page of it. */
  done: number
  /**
   * What the provider says it has billed, where it says. Null for Google, which
   * bills nobody, and for a provider that reports against the account rather
   * than per call — see `AiUsage.cost`, and note that null and nought are
   * different answers.
   */
  cost: number | null
}

/** What one page's run came to, for the sentence that reports it. */
export interface TranslateOutcome {
  /** Lines the run wrote. */
  written: number
  /** Lines it left alone because somebody had already written them. */
  kept: number
}

/**
 * What each effort setting is worth in thinking, as a share of what it writes.
 *
 * Beside the estimate rather than in the panel that draws it, which is where it
 * used to be. A reasoning model bills its hidden thinking at the output rate,
 * so this is a third of the bill on the thorough setting — a number that
 * decides what somebody is charged does not belong in a list of labels.
 */
const THINKING: Record<Effort, number> = {
  fast: 0,
  balanced: 0.2,
  thorough: 0.75,
}

/**
 * The JSON the model has to write around the lines themselves: the quoting and
 * comma per entry, and the object with its `source_language`, `glossary` and
 * `cast` that every reply carries whether or not it learned anything.
 */
const PER_ANSWER = 6
const SCAFFOLD = 40

/**
 * How many pages a run keeps asked about and not yet written.
 *
 * Counted as *unwritten*, not as requests in the air, and that is the bound
 * that matters: a page is asked at most this many pages ahead of what the run
 * has learned, so it is also how far a page's prompt can lag the glossary — and
 * so how often `askAgain` has anything to say. Three is where the waiting stops
 * being the run's problem without a slow first page letting a pile of answers
 * build up behind it, each asked knowing less than the last. A provider that
 * rate-limits the run drops it to one for the rest of it — see `RateGate` — and
 * a page that has to be asked again drops it to one for a while (`width`).
 */
const IN_FLIGHT = 3

/**
 * A run that pages are handed to as they become ready, rather than all at
 * once — the auto run's, which reads and cleans the next page while this one is
 * out being translated. `run` is the same thing with every page handed over up
 * front.
 */
export interface TranslateRun {
  /**
   * Hand a page over, at its place in the run (one-based on screen, as `at + 1`).
   * Resolves once the page has been written, with what came of it — or with
   * null where it never was: the run was stopped before asking about it, a page
   * before it was refused, or the chapter or the language went.
   */
  add: (target: ComicPage, at?: number) => Promise<TranslateOutcome | null>
  /** Whether an ask has been refused, after which the run asks about nothing more. */
  readonly failed: boolean
  /** Ask about nothing more. What is already out still lands, where its reading still stands. */
  stop: () => void
  /** No more pages are coming. Resolves once everything handed over has landed or been let go. */
  close: () => Promise<void>
}

/** One line of an answer, with the block it was asked about as that block was then. */
interface Line {
  block: Block
  /** Its id when asked — the name a live re-read of the same row still answers to. */
  id: string
  /** What it said when asked, so an answer to a reading since replaced is not written onto the new one. */
  source: string
  text: string
  /** Whether a model wrote it, as opposed to a line answered as itself. */
  asked: boolean
}

/** One page's answer, before any of it has been written. */
interface Reply {
  lines: Line[]
  /** What its prompt carried — null where no prompt carried anything (Google, or nothing to ask). */
  heard: SettledNames | null
  /** Every source the model was shown, context included. */
  shown: string[]
  learnedTerms: { src?: string, tr?: string }[]
  learnedCast: { name?: string, tr?: string, gender?: string, tags?: string[] }[]
  /** Sentences for the reader about this page, said when it is written rather than when it answers. */
  notes: string[]
  /** Lines the plan left alone because somebody had written them. */
  kept: number
}

const messageOf = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown))

/** What one page would cost to put through, near enough to be worth showing. */
export interface TranslateEstimate {
  input: number
  output: number
  thinking: number
  cost: number
  /** Whether the press being costed is the one that replaces existing lines. */
  force: boolean
  /** Whether the prices are OpenRouter's or still the built-in placeholders. */
  priced: boolean
}

/** What a press would do to one page, before anything has been sent. */
export interface PagePlan {
  /** Blocks that will be lettered: not rubbish, not hidden, not empty. */
  shown: Block[]
  /** Of those, the ones a machine could actually have something to say about. */
  worth: Block[]
  /** Blocks that read the same in any language and cost nothing to answer. */
  asItself: Block[]
  /** Blocks this press will ask about. */
  pending: Block[]
  /**
   * The block named by an `only` ask, or null for a page run.
   *
   * Carried on the plan rather than re-derived, because `askShape` cannot tell
   * "one block asked for by name" from "a page run with one line missing" by
   * counting — and the two behave differently under the context switch.
   */
  asked: Block | null
  /** Lines already written that a page run will not touch. */
  kept: number
}

/**
 * What a press would do to a page: the lines it would write, the lines it would
 * answer for nothing, and the lines it would send.
 *
 * Pure, and exported, for two reasons that turn out to be the same one. The
 * panel counts what a press would cost *before* it is pressed and the run does
 * the work, and a count that promised eight lines against a run that wrote six
 * is a bug report nobody can reproduce — so there is one function and both call
 * it. And a decision about spending somebody's money is worth a test that does
 * not involve standing a workspace up.
 *
 * Three asks, and the difference between them is entirely *which lines count as
 * pending*:
 *
 * - the ordinary page run fills in the lines that have none, and touches
 *   nothing that already says something;
 * - `force` asks for every line again, whatever it currently says. It is what
 *   "Translate page again" presses, and the reason it has to exist is that a
 *   page carried over with Google is a page whose every line is filled — so
 *   without it, trying the same page against a model is an ask with no button;
 * - `only` names a single block, which is the same ask narrowed to one line.
 *
 * `asItself` is empty for `only` and not for `force`, which looks inconsistent
 * and is not. Filling in the page's logos as a side effect of asking about one
 * balloon would be an edit nobody requested, landing on the undo stack under
 * somebody else's press; asking for the whole page again is a request for
 * exactly that.
 */
export function planPage (
  blocks: Block[],
  locale: string,
  { only, force = false }: { only?: string, force?: boolean } = {},
): PagePlan {
  // Top level only — a balloon somebody joined *is* the object and carries the
  // line, while its columns carry only their own boxes (see `Block.children`).
  // Rubbish and hidden blocks are left out because neither will be lettered,
  // and paying a model to translate something nobody will read is the purest
  // form of the waste this file is careful about.
  const shown = blocks.filter((block) =>
    block.type !== 'garbage' && !block.hidden && block.source.trim())

  // Judged over the whole page, not over what is missing, because the question
  // "is this block the odd one out" can only be asked of the page.
  const script = pageScript(shown.map((block) => block.source))
  const worth = shown.filter((block) => needsTranslation(block.source, locale, script))

  const spare = shown.filter((block) => !worth.includes(block))

  if (only !== undefined) {
    const pending = worth.filter((block) => block.id === only)

    return {
      shown,
      worth,
      asItself: [],
      pending,
      asked: pending[0] ?? null,
      kept: 0,
    }
  }

  if (force) {
    return { shown, worth, asItself: spare, pending: worth, asked: null, kept: 0 }
  }

  return {
    shown,
    worth,
    asItself: spare.filter((block) => !block.translation.trim()),
    pending: worth.filter((block) => !block.translation.trim()),
    asked: null,
    kept: shown.filter((block) => block.translation.trim()).length,
  }
}

/**
 * Which lines actually go out, and which one of them is being asked about.
 *
 * Its own function because two things need the answer and they must not
 * disagree: the request, and the estimate of what the request will cost. A
 * panel that costed the whole page while the run sent one line — or the other
 * way about — would be wrong by a factor of the page length, which is exactly
 * the size of error nobody notices until the bill.
 *
 * `one` is an index into `sent`, or -1 for "answer for all of them". It is worth
 * taking whenever a single line is wanted from a page of context: the model
 * writes one string instead of thirty, and the output is most of the cost.
 *
 * The context switch decides one thing only: whether a page run carries its
 * *already-translated* lines along for the model to lean on. It does not
 * decide whether a block asked for by name gets its page — that ask always
 * travels with the page around it, because the whole reason to ask about one
 * balloon is a line that cannot be read alone: `怎...` sent by itself came back
 * as a standalone "what?" for anyone who had turned the switch off, which is
 * the exact failure the single-block button was built to fix.
 */
export function askShape (plan: PagePlan, context: boolean): { sent: Block[], one: number } {
  if (plan.asked) {
    const sent = plan.worth

    return { sent, one: sent.length > 1 ? sent.indexOf(plan.asked) : -1 }
  }

  const sent = context ? plan.worth : plan.pending

  return {
    sent,
    one: plan.pending.length === 1 && sent.length > 1 ? sent.indexOf(plan.pending[0]!) : -1,
  }
}

export function useTranslate () {
  const { pages, page, at, translate, updateMany, epoch } = useComic()

  const { require } = useProviderKeys()
  const { shared, pageRowOf } = useShared()
  const { target: locale } = useTargetLanguage()
  const { terms, ready: glossaryReady, learn } = useGlossary()

  // Who these people are, which is the other half of what keeps a volume
  // consistent — see `useCast`. The glossary spells a name the same way
  // twice; this is what stops the character behind it changing sex.
  const { ready: castReady, forPrompt: castNow, learn: learnCast } = useCast()

  // The live list, so a price on screen is a price somebody will be billed —
  // see `useModels`, and the two ways the old snapshot could not be.
  const { byId, current: currentModels } = useModels()

  // Every call, as the provider reported it — see `useAiUsage`.
  const { record } = useAiUsage()

  const route = useRoute()
  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const progress = useState<TranslateProgress | null>('translate-progress', () => null)
  const error = useState<string | null>('translate-error', () => null)

  /**
   * What the last run left standing, so the panel can say so.
   *
   * A page whose lines were mostly typed by hand comes back looking untouched,
   * and without a word about it the button reads as broken. The earlier build
   * learned this the hard way and said it in a banner; this is the same
   * sentence's worth of fact, kept where a panel can phrase it.
   */
  const kept = useState<number>('translate-kept', () => 0)

  /**
   * The last press that wrote anything, so it can be taken back.
   *
   * One press, not a stack: "undo the thing I just did" is the whole of what
   * anybody wants here, and a history of runs is what the revision list already
   * is, one line at a time. Cleared when the next run starts, because by then
   * the offer would be for a run whose lines have been written over.
   *
   * `pageIds` names exactly the pages the run wrote, and it is the whole of
   * what makes undo honest and cheap: without the list, taking back a one-page
   * press meant asking *every* page in the chapter — two hundred reverts and
   * two hundred re-reads for one balloon — and re-reading pages the run never
   * touched could overwrite a local line whose save had failed, which is the
   * very line `persist` promises to keep.
   */
  const lastRun = useState<{ batch: string, pageIds: string[], lines: number } | null>(
    'translate-last-run',
    () => null,
  )

  const running = computed(() => progress.value !== null)

  /** Whether the engine in force spends a key. */
  const usesModel = computed(() => translate.value.engine !== 'google')

  const model = computed(() => byId(translate.value.model))

  /** `planPage` against the language this chapter is being carried into. */
  const planFor = (target: ComicPage, options?: { only?: string, force?: boolean }) =>
    planPage(target.blocks, locale.value, options)

  /** How many lines pressing "Translate page" would write, for the button. */
  const pending = computed(() => (page.value ? planFor(page.value).pending.length : 0))

  /** Pages with something to carry over, for the chapter-wide press. */
  const pendingPages = computed(() =>
    pages.value.filter((target) => planFor(target).pending.length).length)

  /**
   * Whether there is anything here that *could* be put through again, which is
   * a different question from whether anything is missing.
   *
   * The one the panel was not asking, and the bug that came of it: a page
   * carried over with Google has no missing lines, so `pending` was nought, so
   * the button and the menu behind it both greyed out — and trying the same
   * page against a model became an ask with no way to make it.
   */
  const canRedo = computed(() => (page.value ? planFor(page.value, { force: true }).pending.length : 0))

  const redoPages = computed(() =>
    pages.value.filter((target) => planFor(target, { force: true }).pending.length).length)

  /**
   * What pressing the button would cost, from the prompt it would actually
   * send.
   *
   * The prompt is built here rather than guessed at, and that is the whole
   * change. What stood here before was a formula of invented coefficients —
   * `source.length * 1.8 + blocks * 26 + (context ? 180 : 0)` — which had four
   * things wrong with it at once:
   *
   * - it counted **every** non-rubbish block on the page, so it costed hidden
   *   blocks, empty blocks, and the logos `needsTranslation` never sends;
   * - it could not see the standing instructions, which are most of a page
   *   prompt: several hundred tokens of English about honorifics, JSON shape,
   *   glossary and cast, none of which appeared in the arithmetic;
   * - it estimated the *output* from the translations already on the page, so a
   *   fresh page — the one case where you actually want to know the price —
   *   costed almost nothing; and
   * - it priced the result against the placeholder rates in `AI_MODELS`,
   *   because nothing ever called the function that was meant to replace them.
   *
   * `pagePrompt` is pure, so the honest version is simply to call it and count
   * what comes back. Every one of those four then fixes itself, and the number
   * tracks the glossary, the honorifics switch, the context switch and the
   * single-line form without any of them having to be modelled twice.
   *
   * It costs whichever press the button is offering — filling the gaps, or
   * doing the page again — because those differ by the whole page.
   */
  const estimate = computed<TranslateEstimate | null>(() => {
    const target = page.value

    if (!usesModel.value || !target) return null

    // The button offers "again" exactly when nothing is missing, so that is the
    // press being costed. See the panel, which decides the same way.
    const force = pending.value === 0
    const plan = planFor(target, { force })

    if (!plan.pending.length) return null

    const { sent, one } = askShape(plan, translate.value.context)

    const hasImage = translate.value.engine === 'ai-image'
      && model.value.vision
      && Boolean(target.scan)

    const prompt = pagePrompt({
      blocks: sent.map((block) => block.source),
      target: locale.value,
      glossary: terms.value,
      // Synchronously, unlike the run's `castReady()`: an estimate cannot await
      // a fetch, and the list is already in hand whenever the panel has been
      // open. Before the first load it reads as empty, which under-counts by
      // the size of the cast block for exactly one render.
      cast: castNow(),
      honorifics: translate.value.honorifics,
      hasImage,
      ...(one === -1 ? {} : { only: one }),
    })

    const picture = hasImage && target.scan
      ? imageTokens(target.scan.width, target.scan.height, IMAGE_MAX_EDGE)
      : 0

    const input = estimateTokens(prompt) + picture

    // Answered for, which is not the same as written down: with `only` the
    // model returns one line however many it was shown, and that is most of the
    // saving. Without it, it writes one per block sent — including the ones
    // whose answers a page run will read and discard.
    const answering = one === -1 ? sent : [plan.pending[0]!]

    /*
     * Output is estimated at one token out per token of source in, which looks
     * like a fudge and is closer to an identity. A token is roughly a unit of
     * meaning rather than of length: a script that packs about a token per
     * character carries some four times the meaning per character of one at a
     * quarter of a token, so the *character* count swings wildly between
     * Japanese and English while the token count of the same sentence does not
     * move much. Which direction the translation runs therefore mostly cancels.
     *
     * It is still the crudest number here — a terse line rendered into
     * idiomatic English can run half again as long — so it errs by tens of per
     * cent, not by multiples. That is the accuracy this figure claims.
     */
    const written = answering.reduce((total, block) => total + estimateTokens(block.source), 0)
    const output = Math.round(written + answering.length * PER_ANSWER + SCAFFOLD)

    const thinking = Math.round(output * THINKING[translate.value.effort])

    const { price } = model.value

    return {
      input,
      output,
      thinking,
      force,
      // This model's own flag, not the fetch's: a curated id OpenRouter did
      // not answer for is still a placeholder even after the fetch landed.
      priced: model.value.priced,
      cost: (input * price.in + (output + thinking) * price.out) / 1_000_000,
    }
  })

  /**
   * One page's worth of asking, whichever engine is in force — and nothing
   * more. What comes back is written, and learned from, in `commit`, in page
   * order; this only asks.
   *
   * It used to learn as well, straight off the reply, which was right while a
   * run asked one page at a time: "what this page taught, before the next page
   * is asked anything". With three out at once the reply that lands first is
   * not the page that comes first, and learning here would let page six's
   * spelling of a name beat page five's to the glossary — first translation
   * wins, in the order the answers happened to arrive.
   *
   * `only` names a single block to answer for; everything else on the page
   * still goes, as context. Google ignores it — it translates a phrase at a
   * time and has no context to be given — so there the one block is simply the
   * only thing sent.
   *
   * Every line is held with the block it answers *as that block was when
   * asked* — see `Line`, and `commit` for why an answer is written only onto
   * the reading it was asked about.
   */
  async function ask (
    target: ComicPage,
    plan: PagePlan,
    key: string | undefined,
    say: (message: string) => void,
    gate: RateGate,
    language: string,
  ): Promise<Reply> {
    const line = (block: Block, text: string, asked: boolean): Line =>
      ({ block, id: block.id, source: block.source, text, asked })

    // The free half: a logo or a bare "!?" is its own translation.
    const reply: Reply = {
      lines: plan.asItself.map((block) => line(block, block.source, false)),
      heard: null,
      shown: [],
      learnedTerms: [],
      learnedCast: [],
      notes: [],
      kept: plan.kept,
    }

    if (!plan.pending.length) return reply

    if (!usesModel.value) {
      say(`Translating ${plan.pending.length} line${plan.pending.length === 1 ? '' : 's'}…`)

      const { translations, failed } = await googleTranslateAll(
        plan.pending.map((block) => block.source),
        language,
        (done, total) => say(`Translating line ${done} of ${total}…`),
      )

      // Every line back empty means the endpoint, not the lines — Google is
      // undocumented and may simply have stopped answering us.
      if (translations.every((each) => !each)) {
        throw new Error('Google Translate could not be reached — try again, or switch to an AI engine.')
      }

      // Some refused among many is a page worth keeping — but said, not
      // swallowed: a balloon left empty with no word about it reads as one the
      // run forgot, when it is one the endpoint turned down.
      if (failed) {
        reply.notes.push(`${failed} line${failed === 1 ? '' : 's'} came back untranslated — Google refused them. Press again for the gaps, or switch engines.`)
      }

      for (const [index, block] of plan.pending.entries()) {
        const text = translations[index]

        if (text) reply.lines.push(line(block, text, true))
      }

      return reply
    }

    // The whole page or only what is missing — see the header. Either way the
    // numbering the model answers against is this list's, so it is built once
    // and the answers are read back through it.
    const { sent, one } = askShape(plan, translate.value.context)

    if (!key) throw new Error('No OpenRouter key — add one in settings.')

    say(`Asking ${model.value.label}…`)

    // What this prompt carries, kept beside the answer: whether the answer can
    // be written as it is depends on what the run settles before its turn
    // comes — see `askAgain`. Copied, because the list in hand is replaced
    // under this page as the pages before it teach it things.
    const heard: SettledNames = {
      terms: (await glossaryReady()).map(({ source, target: rendering }) => ({ source, target: rendering })),
      cast: await castReady(),
    }

    const result = await translatePage(key, {
      blocks: sent.map((block) => block.source),
      target: language,
      glossary: [...heard.terms],
      cast: heard.cast,
      honorifics: translate.value.honorifics,
      model: model.value,
      effort: REASONING_FOR[translate.value.effort],
      // The page itself, for the engine that reads pictures. Shrunk inside
      // `translatePage`, which is where the reason for the size lives.
      image: translate.value.engine === 'ai-image' ? target.scan?.file ?? null : null,
      // A rate limit or a dropped connection is asked about again inside the
      // errand, after a wait of up to half a minute — said here, or it reads as
      // a model thinking.
      retrying: (wait) => say(`${model.value.label} could not answer just now — asking again in ${Math.ceil(wait / 1000)} s…`),
      gate,
      ...(one === -1 ? {} : { only: one }),
    })

    // Money is spent when the answer arrives, whether or not it is written, so
    // it is counted here rather than in `commit`: on the run's running total,
    // which is the figure a reader watches during a chapter, and on the ledger
    // — see `useAiUsage` — per call rather than per run, because a call is the
    // thing a provider bills. An answer let go was still paid for.
    if (result.usage) {
      const { cost } = result.usage

      if (cost !== null && progress.value) {
        progress.value = { ...progress.value, cost: (progress.value.cost ?? 0) + cost }
      }

      await record({
        at: Date.now(),
        pageId: target.id,
        page: target.name,
        model: model.value.label,
        input: result.usage.input,
        output: result.usage.output,
        reasoning: result.usage.reasoning,
        cost,
      })
    }

    if (one === -1) {
      // The model was asked for one line per block sent, in order. A short list
      // is a model that lost count, and the lines it did give are still in
      // order — so they land on the blocks they belong to and the rest stay
      // pending rather than the whole page being thrown away.
      for (const [index, block] of sent.entries()) {
        const text = result.translations[index]?.trim()

        if (text && plan.pending.includes(block)) reply.lines.push(line(block, text, true))
      }
    } else {
      const text = result.translations[0]?.trim()

      if (text) reply.lines.push(line(plan.pending[0]!, text, true))
    }

    /*
     * Lines the model answered with something that is not a line — see
     * `lineOf` in `utils/openrouter`. They stay gaps, like a line it skipped,
     * but said rather than left to look like one the run forgot. Counted only
     * among the lines being asked about: an unreadable answer for a line that
     * was only context was going to be thrown away anyway.
     */
    const unread = result.unreadable.filter((index) => {
      const block = one === -1 ? sent[index] : plan.pending[0]

      return block !== undefined && plan.pending.includes(block)
    }).length

    if (unread) {
      reply.notes.push(`${unread} line${unread === 1 ? '' : 's'} came back from ${model.value.label} as something other than text, and ${unread === 1 ? 'was' : 'were'} left empty. Press again for the gaps.`)
    }

    return {
      ...reply,
      heard,
      shown: sent.map((block) => block.source),
      learnedTerms: result.learnedTerms,
      learnedCast: result.learnedCast,
    }
  }

  /**
   * Write a page's lines to the workspace, where there is one to write to.
   *
   * `useTranslationSync` does this for the page on screen and only for that
   * page — it watches the open blocks, which is the right shape for typing and
   * the wrong one for a run that lands on page forty while page one is open.
   * So a run saves what it wrote itself, through `saveRun`, which agrees the
   * lines with the watcher *before* sending them. This used to agree only once
   * the server had answered, and the watcher — woken by the same `updateMany`
   * that put the lines on the page — sent them again half a second later as
   * somebody's typing. When this save was slow or failed, that copy won: the
   * model's words pinned as a person's, and out of the batch Undo takes back.
   *
   * Best effort, and deliberately: the lines are on the page either way, and a
   * server that cannot be reached is no reason to discard a translation that
   * cost real money. `saveRun` asks again, and failing that leaves the lines
   * owed under this run's name for the watcher to carry on its next save of
   * the page; this says so, without stopping the run.
   */
  async function persist (target: ComicPage, written: Block[], run?: string, by?: Omit<RunOrigin, 'batch'>) {
    if (!written.length) return
    if (!atLeast(shared.value?.role, 'translator')) return

    const pageId = pageRowOf(target)

    if (!pageId) return

    // Read once, and used both to send and to agree. `useTranslationSync.flush`
    // says why at length: what these words are is inseparable from which
    // language they were written in, and a target changed while the request was
    // in flight would otherwise have them agreed under a language they were
    // never sent to — where they would then stand as the record for a page
    // nobody had translated.
    const language = locale.value

    // The size the watcher converts frames at, so that what is agreed here is
    // exactly what it computes for the same blocks — an agreement it does not
    // recognise is no agreement, and it sends the lines itself. The scan's own
    // width, which this read, is nought for a page whose file is elsewhere, and
    // every re-lettered frame on it went out converted at a guessed shape.
    // Measured only where nothing has yet: `sized` reads a header, and until
    // the lines are agreed the watcher is free to act.
    const known = pageSize(target)
    const scan = known.width && known.height ? known : await sized(target)

    // Through `translationEntry` rather than built here, which is what stops a
    // run from wiping work it knows nothing about. The server writes every
    // column an entry names and reads a missing one as null, so this list having
    // its own idea of what a row holds meant a translation run silently putting
    // every re-lettered balloon on the page back on its block — see
    // `Block.letter`, and the note on the function itself.
    const entries = written.flatMap((block) => {
      const row = rowOf(block)

      return row ? [translationEntry(block, row, scan)] : []
    })

    if (!entries.length) return

    /*
     * Who wrote these, which this path is the only one that knows.
     *
     * Sent on every machine write and on no other, because it is the whole of
     * how the server tells a run from a keystroke — see
     * `translations.putOnPage`. Without it every AI translation was filed as
     * `engine: 'human'`, which is both wrong on its face and would have made a
     * revision history unreadable: every row in the list claiming to be
     * somebody's own wording.
     *
     * `run` groups the page's lines so the whole press can be taken back.
     * `by` is who answered, where the caller held on to it across a request
     * the reader could have changed the engine during — see `shortenBlock`.
     */
    const failed = await saveRun(workspace.value, pageId, language, entries, {
      engine: by?.engine ?? translate.value.engine,
      model: by ? by.model : (usesModel.value ? model.value.id : null),
      batch: run ?? null,
    })

    if (failed) error.value = `The translation is on the page but was not saved: ${failed}`
  }

  /**
   * Let go of the claim on these lines, so a run may move them.
   *
   * Quiet on failure, like `persist`: the words still land on the page either
   * way, and the worst a missed release costs is that the server keeps the old
   * wording as the head until somebody presses again.
   */
  async function release (target: ComicPage, blocks: Block[]) {
    if (!atLeast(shared.value?.role, 'translator')) return

    const pageId = pageRowOf(target)
    const rows = blocks.map(rowOf).filter((row): row is number => row !== null)

    if (!pageId || !rows.length) return

    await $fetch(`/api/workspaces/${workspace.value}/pages/${pageId}/unpin`, {
      method: 'POST',
      body: { locale: locale.value, blockIds: rows },
      headers: peerHeader(workspace.value),
    }).catch(() => {})
  }

  /**
   * Open a run: the bookkeeping every run shares, and pages asked about a few at
   * a time and written one at a time, in the order they were handed over — see
   * "Three pages out at once" in the header. Null while a run is going already.
   *
   * `total` is only for the progress line, which reads "page 3 of 12".
   */
  function begin (total: number, options: { only?: string, force?: boolean } = {}): TranslateRun | null {
    if (running.value) return null

    // What this run is for. A chapter closed mid-run takes its pages with it,
    // and the writes would land on pages nobody can reach; a target language
    // changed mid-run makes every answer still out one for a language nobody
    // is working in now — `persist` would have filed it under the new one.
    // Either way nothing more is asked or written.
    const started = epoch.value
    const language = locale.value
    const current = () => epoch.value === started && locale.value === language

    /*
     * What this press is called, so everything it writes can be taken back
     * together.
     *
     * Minted here and not per page: the run is the unit somebody wants to undo,
     * and a chapter-wide press that stamped a different batch on every page
     * would leave thirty separate undos where the reader made one decision.
     *
     * `crypto.randomUUID` rather than a counter, because two browsers
     * translating the same chapter at the same time would otherwise mint the
     * same name for two different runs and revert each other's work.
     */
    const batch = crypto.randomUUID()

    /** The run's share of the provider's patience — see `RateGate`. */
    const gate: RateGate = { until: 0, limited: false }

    error.value = null
    kept.value = 0
    lastRun.value = null
    progress.value = { page: 1, pages: Math.max(1, total), message: 'Starting…', done: 0, cost: null }

    /*
     * Asked for once, before the first page rather than per page: a chapter's
     * worth of pages should not each wait on the same fetch, and a missing key
     * should stop the run at nought rather than at page one. The glossary and
     * the cast are read for the same reason — a local workspace's from this
     * browser, a cloud one's from the server; see `useGlossary` and `useCast`.
     *
     * Not before the run is *handed* one, though. The auto run opens its run
     * before reading anything and hands a page over only when it has lines to
     * carry; over a chapter already carried over it hands over none, and asking
     * for a key then would end a run that had nothing to ask a model.
     */
    let readying: Promise<string | undefined> | null = null

    const ready = () => (readying ??= (async () => {
      // Desktop: on the newest version of the chosen family — see `useModels.current`.
      if (usesModel.value) await currentModels()

      const key = usesModel.value ? await require('openrouter', model.value) : undefined

      await glossaryReady()
      await castReady()

      return key
    })())

    interface Slot {
      target: ComicPage
      at: number
      landed: (outcome: TranslateOutcome | null) => void
      reply?: Promise<Reply>
    }

    /** Handed over and not yet asked about. */
    const waiting: Slot[] = []
    /** Asked about and not yet written, in the order they will be written. */
    const out: Slot[] = []

    /** The last thing each page said about itself, so the line can follow the page being waited on. */
    const said = new Map<number, string>()
    const touched: string[] = []

    let closed = false
    let halted = false
    let refused = false
    let failure: string | null = null
    let lines = 0
    let held = 0
    let head = 0
    let next = 0
    let nudge: (() => void) | null = null

    const wake = () => {
      nudge?.()
      nudge = null
    }

    /**
     * The progress line follows the page the run is waiting on — the next to be
     * written — rather than whichever of the three spoke last, because that is
     * the page the percentage is counting and the one a reader is waiting for.
     */
    const show = () => {
      if (!progress.value) return

      progress.value = {
        ...progress.value,
        page: Math.min(head + 1, progress.value.pages),
        message: said.get(head) ?? progress.value.message,
        done: lines,
      }
    }

    const sayFor = (at: number) => (message: string) => {
      said.set(at, message)

      if (at === head) show()
    }

    /**
     * Pages written in a row without being asked again — see `width`. Starts
     * as though the run had been calm, so it opens wide.
     */
    let calm = IN_FLIGHT

    /**
     * How many may be out: `IN_FLIGHT` for a model, one for Google — see the
     * header — and one from the moment the provider rate-limits this run.
     *
     * And one after a page had to be asked again, until `IN_FLIGHT` pages in a
     * row have been written without that. A page asked again means the chapter
     * is still introducing itself — names settled on one page and used on the
     * next — and while that lasts, asking ahead only buys answers that will be
     * asked for twice: they come back in order either way, so a stretch where
     * every page used the last page's new name cost nearly double and saved no
     * time at all. One at a time through such a stretch costs what a run always
     * did; the run widens again once it is past.
     */
    const width = () => (usesModel.value && !gate.limited && calm >= IN_FLIGHT ? IN_FLIGHT : 1)

    /** One page's ask, planned against the page as it is when asked. */
    async function askPage (slot: Slot, key: string | undefined, again = false): Promise<Reply> {
      const plan = planFor(slot.target, options)

      /*
       * "Again" — and an ask for one block by name — gives up the claim before
       * asking for anything.
       *
       * A line somebody typed is pinned, and the server will not let a machine
       * move it — which is precisely the guarantee the ordinary press relies on
       * and precisely what these two presses are asking to set aside. Cleared
       * first, so the run's answers land rather than being filed as revisions of
       * a line that goes on saying what it said. Without this the single-block
       * press only *looked* like it replaced a typed line: the browser showed
       * the model's answer while the server kept the typed head, and the typed
       * wording came silently back on the next reload.
       *
       * Before the request, not after: a run that fails should have changed
       * nothing except the claim, and a claim given up on a line that then keeps
       * its wording is the state the reader asked for anyway. Once: a page asked
       * again by `askAgain` has given its claims up already.
       */
      if (!again && plan.pending.length && (options.force || options.only !== undefined)) {
        await release(slot.target, plan.pending)
      }

      return ask(slot.target, plan, key, sayFor(slot.at), gate, language)
    }

    /** Ask about as many of the waiting pages as there is room for. */
    function pump () {
      while (out.length < width() && waiting.length) {
        if (halted || refused || !current()) return

        const slot = waiting.shift()!

        slot.reply = ready().then((key) => askPage(slot, key))

        // Heard at once rather than in its turn: a refusal ends the run, so
        // nothing more is asked about from the moment one arrives — and the
        // auto run, which reads `failed`, stops at its next stop.
        slot.reply.catch(() => {
          refused = true
          wake()
        })

        out.push(slot)
      }
    }

    /**
     * Write one page — its lines, their save, and what it taught — once every
     * page before it has been.
     *
     * **Asked again first where `askAgain` says so**, with the glossary and the
     * cast as the pages before this one have left them. The second answer is
     * the one written, and it is not checked again: every page before it has
     * been written, so it was asked exactly what a one-at-a-time run would have
     * asked it.
     *
     * **Onto the reading it was asked about, or not at all.** Each line goes to
     * the block it was asked about — found as the same object, which survives a
     * block being given its row and renamed while the page was out, or by the
     * id it had then, which survives a collaborator's edit re-reading the same
     * rows into new objects — and only while that block still says what it
     * said when it was sent. A page read again while its translation was out
     * has new blocks under new ids, so nothing of the answer lands on it; a line
     * somebody corrected meanwhile keeps its gap for the next press. The auto
     * run gave this its urgency: it reads page seven while page six is out, and
     * a stop there leaves page six's answer arriving after the run has handed
     * the chapter back.
     *
     * **Learned from only if it landed.** A page none of whose lines could be
     * written is a page nobody will read, and what it taught would go on
     * prompting every later page with a reading that is gone — the rule
     * `saveAnswers` keeps on the MCP side for the same reason.
     */
    async function commit (slot: Slot, first: Reply): Promise<TranslateOutcome | null> {
      let reply = first

      if (reply.heard) {
        const why = askAgain(
          reply.heard,
          { terms: terms.value, cast: castNow() },
          { shown: reply.shown, answered: reply.lines.filter((line) => line.asked) },
          language,
        )

        if (why) {
          calm = 0
          sayFor(slot.at)(`Asking about page ${slot.at + 1} again — “${why}” was settled while it was out…`)

          reply = await askPage(slot, await ready(), true)

          if (!current()) return null
        } else {
          calm += 1
        }
      }

      // By id, not the object held: a page list rebuilt around it is still the
      // same page, and one removed from the chapter is nowhere to write.
      const here = pages.value.find((candidate) => candidate.id === slot.target.id)

      if (!here) return null

      const patches: { id: string, patch: Partial<Block> }[] = []

      for (const line of reply.lines) {
        const block = here.blocks.find((candidate) => candidate === line.block)
          ?? here.blocks.find((candidate) => candidate.id === line.id)

        if (block && block.source === line.source) patches.push({ id: block.id, patch: { translation: line.text } })
      }

      // An answer none of which can be written is an answer about a reading
      // that is gone — let go, like a page that was never asked about, rather
      // than reported as a page with nothing to say.
      if (reply.lines.length && !patches.length) return null

      // Named rather than assumed, because this page may not be the one on
      // screen: a chapter-wide run writes page forty while page one is open.
      updateMany(patches, here.id)

      const ids = new Set(patches.map((patch) => patch.id))

      await persist(here, here.blocks.filter((block) => ids.has(block.id) && block.translation), batch)

      // What this page taught, before the page after it is written — or asked
      // again. Failing to record it costs consistency and nothing else, so it
      // does not end a run over a glossary; `learn` already swallows its own.
      // Asked after the save's await, because `learn` files under whatever
      // language is current when it is called.
      if (patches.length && current()) {
        try {
          if (reply.learnedTerms.length) await learn(reply.learnedTerms)
          if (reply.learnedCast.length) await learnCast(reply.learnedCast, language)
        } catch (thrown) {
          console.warn('[kemolate] what a page taught was not kept:', thrown)
        }
      }

      for (const note of reply.notes) error.value = note

      lines += patches.length
      held += reply.kept
      kept.value = held

      /*
       * The offer to take it back grows page by page rather than being made at
       * the end, because the run that most needs undoing is the one that did
       * not finish: a chapter-wide "again" that replaced three pages of typed
       * lines and then timed out on the fourth had already done the damage, and
       * an offer written only after the loop was never made for exactly those
       * pages. A run that wrote nothing still offers nothing.
       */
      if (patches.length) {
        touched.push(here.id)
        lastRun.value = { batch, pageIds: [...touched], lines }
      }

      show()

      return { written: patches.length, kept: reply.kept }
    }

    /*
     * The writer: one page at a time, in order, however the answers arrive.
     * Everything above only asks.
     */
    const writer = (async () => {
      while (!failure) {
        pump()

        const slot = out[0]

        if (!slot) {
          if (closed || halted || refused || !current()) break

          await new Promise<void>((resolve) => { nudge = resolve })

          continue
        }

        head = slot.at
        show()

        try {
          const reply = await slot.reply!

          if (!current()) break

          slot.landed(await commit(slot, reply))
        } catch (thrown) {
          failure = messageOf(thrown)

          break
        }

        out.shift()
      }

      /*
       * Whatever never landed is let go: pages asked after one that was
       * refused, and anything still out when the chapter or the language went.
       * Their answers are waited for before the run says it is over, so nothing
       * it asked for arrives after it has handed the chapter back.
       */
      for (const slot of out) {
        await slot.reply?.catch(() => {})
        slot.landed(null)
      }

      for (const slot of waiting) slot.landed(null)

      out.length = 0
      waiting.length = 0

      if (failure) error.value = failure

      progress.value = null
    })()

    return {
      add (target, at = next) {
        next = Math.max(next, at + 1)

        if (closed || halted || refused || failure) return Promise.resolve(null)

        return new Promise((resolve) => {
          waiting.push({ target, at, landed: resolve })
          pump()
          wake()
        })
      },
      get failed () {
        return refused || failure !== null
      },
      stop () {
        halted = true
        wake()
      },
      close () {
        closed = true
        wake()

        return writer
      },
    }
  }

  /** A run over some pages, handed over all at once. */
  async function run (targets: ComicPage[], options?: { only?: string, force?: boolean }) {
    if (!targets.length) return

    const job = begin(targets.length, options)

    if (!job) return

    for (const [at, target] of targets.entries()) job.add(target, at)

    await job.close()
  }

  /** How many lines "Translate page" would write on this page — what the auto run asks before handing it over. */
  const pendingOf = (target: ComicPage) => planFor(target).pending.length

  /**
   * The page on screen.
   *
   * `force` is "again": every line, whatever it says now. It is a separate
   * press rather than a mode because the two are different bargains — the
   * ordinary one cannot cost you a word you wrote, and this one can.
   */
  function translateCurrent (force = false) {
    const target = pages.value[at.value]

    return target ? run([target], { force }) : undefined
  }

  /**
   * Every page with something to carry over.
   *
   * Pages already done are skipped rather than re-sent, which is what makes
   * this safe to press twice — the second press costs whatever the first one
   * failed to finish and nothing more. Under `force` there is nothing to skip:
   * every page with a line on it goes, which is the point of asking.
   */
  function translateAll (force = false) {
    return run(pages.value.filter((target) => planFor(target, { force }).pending.length), { force })
  }

  /**
   * One block, and this one *does* replace what is there.
   *
   * The page button keeps the reader's own wording, which is right when the
   * whole page is being run — but it leaves no way to say "this line, again".
   * This is that: an explicit ask for one line, so whatever is in it gives way.
   *
   * The rest of the page still goes with it. Sent alone, a line that breaks off
   * mid-thought reads as a phrase of its own — the earlier build watched `怎...`
   * come back as "Wh-what..." rather than as the "H—" of the "How could I..." it
   * runs into — and the page's text is a few dozen words against an image that
   * was going to be sent anyway.
   */
  function translateBlock (id: string) {
    const target = page.value

    if (!target) return

    const block = target.blocks.find((candidate) => candidate.id === id)

    if (!block) return

    // A line the page test says needs nothing — a logo, a bare "!?" — is still
    // an explicit ask, so it is answered here rather than refused: with what is
    // actually printed there, which is the right answer and costs nothing. The
    // pin is released like any other explicit replacement, or a typed line
    // would keep its old head on the server while the page showed this one.
    //
    // Released *before* the line is written, not after, which is the order
    // a run keeps (see `askPage` in `begin`). Written first, the answer sat on the page for the
    // whole of the unpin with nothing agreed, and an unpin slower than the
    // watcher's settle let `useTranslationSync` send it first — as typing,
    // pinned against every later run. Written after, the line is on the page
    // and agreed in the same tick (see `saveRun`), so the watcher never sees it.
    if (!planFor(target).worth.includes(block)) {
      return release(target, [block]).then(() => {
        updateMany([{ id, patch: { translation: block.source } }], target.id)

        // Found again: the page may have been re-read during the unpin, and
        // the block `updateMany` just wrote to is then not the one held above.
        const now = target.blocks.find((candidate) => candidate.id === id)

        return now ? persist(target, [now]) : undefined
      })
    }

    // The balloon is not blanked first, and that is deliberate rather than an
    // oversight: a request that fails leaves the words that were there instead
    // of emptying the line on the way to an error. What *is* cleared first is
    // the server's pin, inside the run — see `askPage` in `begin`, which treats
    // an ask-by-name as the same bargain as "again" for that one line.
    return run([target], { only: id })
  }

  /**
   * One line again, shorter — the letterer sending it back.
   *
   * A professional letterer does not shrink the type to make a long line fit
   * its balloon; they return the line for a shorter wording. The lettering side
   * works out `budget` — how many characters the frame holds at the chapter's
   * standard size — and this asks the model in force for the line in at most
   * that many (`shortenPrompt`, `shortenLine`). Answers with what it wrote, or
   * null where it wrote nothing, having said why in `error`.
   *
   * **The answer becomes the line, pinned or not.** The press is the reader
   * asking for exactly this wording to replace exactly this line — the same
   * bargain as "Translate page again" and the single-block press, so the claim
   * is given up (`release`) and the answer is written as the machine's: under
   * its own `batch`, with `engine` and the model's id, so the revision list
   * names who shortened it and Undo (`revertRun`, via `lastRun`) takes the one
   * line back to the wording it replaced. `engine` is `ai-text` whatever the
   * toolbar says, because that is what was asked — no picture goes with this.
   * The claim is given up only once the answer is in hand, unlike a run's: a
   * request that fails should cost a typed line nothing, and release → write →
   * save is the order the as-itself path in `translateBlock` already keeps
   * against the watcher.
   *
   * **Onto the line it was asked about, or nowhere.** Checked when the answer
   * arrives and again after the unpin, as `commit` checks a page: the chapter
   * and the language still the ones it was asked in, the block still there and
   * still saying what it said — source *and* translation. A line somebody
   * retyped while the model was thinking is their newer decision, and a shorter
   * version of the words they replaced is not an answer to it.
   *
   * **Longer than asked is still applied.** A model that could not get there
   * without losing meaning was told to give the tightest faithful version, and
   * that is usually still shorter than what was there. It is written, and
   * returned, so the caller can measure it and say so; this does not ask again,
   * because a second ask gets the same answer or a worse line.
   *
   * Refused outright, before anything is spent, on Google — it has no model to
   * be asked for a rewording — and on a line with nothing in it yet. And not
   * while a run is going: it holds the progress line, and its writes would
   * interleave with this one on the same page.
   */
  async function shortenBlock (block: Block, budget: number): Promise<string | null> {
    if (running.value) return null

    // The object first, then the page on screen by id — a block handed over
    // from the board may have been re-read into a new object since.
    const target = pages.value.find((candidate) => candidate.blocks.includes(block))
      ?? (page.value?.blocks.some((candidate) => candidate.id === block.id) ? page.value : undefined)

    if (!target) return null

    if (!usesModel.value) {
      error.value = 'Shortening a line needs an AI engine — Google Translate has no model to ask. Pick AI · Text or AI · Image in the Translate panel.'

      return null
    }

    const line = target.blocks.find((candidate) => candidate === block)
      ?? target.blocks.find((candidate) => candidate.id === block.id)

    if (!line?.translation.trim()) {
      error.value = 'This line has no translation yet — translate it before shortening it.'

      return null
    }

    if (!Number.isFinite(budget) || budget < 1) {
      error.value = 'This balloon has no room for a line at all — make the frame bigger rather than the line shorter.'

      return null
    }

    // What this ask is about, held as it was when asked — see the header.
    const started = epoch.value
    const language = locale.value
    // Desktop: on the newest version of the chosen family — see `useModels.current`.
    await currentModels()

    const chosen = model.value
    const { id, source, translation } = line
    const batch = crypto.randomUUID()

    const current = () => epoch.value === started && locale.value === language

    /** The block as it stands now, if it is still the line that was asked about. */
    const still = () => {
      const here = pages.value.find((candidate) => candidate.id === target.id)
      const now = here?.blocks.find((candidate) => candidate === line)
        ?? here?.blocks.find((candidate) => candidate.id === id)

      return here && now && now.source === source && now.translation === translation
        ? { here, now }
        : null
    }

    const moved = 'The line changed while it was being shortened, so the shorter wording was not used.'

    error.value = null
    progress.value = { page: 1, pages: 1, message: `Asking ${chosen.label} for a shorter line…`, done: 0, cost: null }

    try {
      const key = await require('openrouter', chosen)

      // The page as translated so far, for voice and for a line that breaks
      // off — see `shortenPrompt`. The lines that will be lettered, in order.
      const shown = planFor(target).shown
      const at = shown.indexOf(line)

      const result = await shortenLine(key, {
        source,
        translation,
        budget,
        target: language,
        glossary: (await glossaryReady()).map(({ source: from, target: to }) => ({ source: from, target: to })),
        cast: await castReady(),
        honorifics: translate.value.honorifics,
        ...(at === -1 ? {} : { page: shown.map((each) => each.translation), at }),
        model: chosen,
        effort: REASONING_FOR[translate.value.effort],
      })

      // Paid for whether or not it lands, so counted before anything is checked.
      if (result.usage) {
        await record({
          at: Date.now(),
          pageId: target.id,
          page: target.name,
          model: chosen.label,
          what: 'shorten',
          input: result.usage.input,
          output: result.usage.output,
          reasoning: result.usage.reasoning,
          cost: result.usage.cost,
        })
      }

      if (!current()) return null

      const asked = still()

      if (!asked) {
        error.value = moved

        return null
      }

      await release(asked.here, [asked.now])

      // Found again: the page may have been re-read, or the line typed over,
      // during the unpin.
      const standing = current() ? still() : null

      if (!standing) {
        if (current()) error.value = moved

        return null
      }

      updateMany([{ id: standing.now.id, patch: { translation: result.text } }], standing.here.id)

      const written = standing.here.blocks.find((candidate) => candidate.id === standing.now.id)

      if (written) await persist(standing.here, [written], batch, { engine: 'ai-text', model: chosen.id })

      lastRun.value = { batch, pageIds: [standing.here.id], lines: 1 }

      return result.text
    } catch (thrown) {
      error.value = messageOf(thrown)

      return null
    } finally {
      progress.value = null
    }
  }

  /**
   * Take the last press back.
   *
   * Every line the run touched goes to the wording it had before it — which is
   * a different wording per line, and is why this is the server's job rather
   * than a snapshot the browser kept. Lines the run *filled in* had nothing
   * before, so they are left as they are: blanking them would be inventing a
   * state the page never had.
   *
   * Only the pages the run wrote, which `lastRun.pageIds` names one by one.
   * Asking every page in the chapter instead — which is what this did — meant
   * a one-page undo issued a request per page of the volume, and re-reading
   * pages the run never touched could overwrite a local line whose save had
   * failed. `revertBatch` takes a page because a batch belongs to a run and a
   * run to a chapter, and undoing a chapter-wide press means asking each page
   * it touched.
   */
  async function revertRun () {
    const last = lastRun.value

    if (!last || running.value) return

    const touched = last.pageIds
      .map((id) => pages.value.find((target) => target.id === id))
      .filter((target): target is ComicPage => target !== undefined && pageRowOf(target) !== null)

    error.value = null

    try {
      for (const target of touched) {
        const pageId = pageRowOf(target)

        if (!pageId) continue

        await $fetch(`/api/workspaces/${workspace.value}/pages/${pageId}/revert`, {
          method: 'POST',
          body: { locale: locale.value, batch: last.batch },
          headers: peerHeader(workspace.value),
        })
      }

      lastRun.value = null

      // The pages on screen still say what the run wrote. `useLiveSync` will
      // hear about a change made in another tab, but not about this one — the
      // peer header is on the request precisely so it does not — so the blocks
      // are read back here.
      await restoreTranslations(touched)
    } catch (thrown) {
      error.value = thrown instanceof Error
        ? `That run could not be taken back: ${thrown.message}`
        : 'That run could not be taken back.'
    }
  }

  /**
   * Read the server's wording back onto pages this browser has just changed
   * behind its own back.
   *
   * The one caller is `revertRun`, and it needs this because a revert is the
   * only write in this file whose result the browser cannot work out for
   * itself: what a line goes back to is whatever revision was under the run,
   * and only the server knows.
   */
  async function restoreTranslations (targets: ComicPage[]) {
    for (const target of targets) {
      const pageId = pageRowOf(target)

      if (!pageId) continue

      const rows = await $fetch<StoredBlock[]>(
        `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
      ).catch(() => null)

      if (!rows?.length) continue

      // Measured rather than read off the scan, which is nought on a page not
      // drawn yet — the frames agreed below would then be agreed at the guessed
      // shape and sent back shrunk by the next save. See `sized`.
      const scan = await sized(target)
      const fresh = toBlocks(rows, scan, locale.value)

      updateMany(
        fresh.map((block) => ({ id: block.id, patch: { translation: block.translation } })),
        target.id,
      )

      // Agreed from the rows as they came back, which is what these blocks are:
      // `fresh` was built by `toBlocks` out of the server's own answer, frame
      // and all, so what is being agreed to is exactly what is on record.
      for (const block of fresh) {
        const row = rowOf(block)

        if (row) agreedTranslation(locale.value, translationEntry(block, row, scan))
      }
    }
  }

  return {
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
    translateBlock,
    shortenBlock,
    revertRun,
    begin,
    pendingOf,
  }
}
