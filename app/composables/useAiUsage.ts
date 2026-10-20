/**
 * What the models have actually been asked, and what it actually came to.
 *
 * The panel next to this one estimates what a press *would* cost. This is the
 * other half and the one that settles arguments: every AI call the browser
 * makes, recorded as the provider reported it, with a total under the lot.
 *
 * ## Why it is kept here rather than on the server
 *
 * Not the usual reason. Nothing about a token count is a scan, so the one
 * invariant would allow a table — but a *workspace* ledger would be the wrong
 * shape regardless. Every contributor translates on **their own key** (see
 * `useProviderKeys`), so a shared total would add up four people's bills into
 * one number that is nobody's, and none of them could find their own inside it.
 * What a reader wants to know is what *they* have spent, which is a fact about
 * this browser and this account.
 *
 * Kept per workspace all the same, because "what did this chapter cost me" is
 * the question people actually ask, and one running total across every chapter
 * ever opened answers a question nobody has.
 *
 * ## Read a page at a time
 *
 * The whole chapter is recorded; the panel is shown one page's worth, because
 * that is the page you are looking at and the one you are about to press the
 * button on. A chapter-long list would put the row you care about at an
 * unpredictable depth and make the total answer a question you did not ask.
 *
 * ## The total does not shrink
 *
 * The rows are capped — a two-hundred-page volume is two hundred calls, and an
 * unbounded list in IndexedDB grows for ever with no one watching. But trimming
 * the oldest rows must not quietly reduce what a page has cost, so what they
 * added up to is folded into `carried` on the way out and a page's total is its
 * carried figure plus whatever of its rows remain.
 *
 * `carried` is therefore keyed **by page** rather than being one running sum,
 * and that is forced by showing a page at a time: a single chapter-wide carried
 * total cannot be attributed back to any page, so the moment rows were trimmed
 * every per-page total would quietly drop by an unknowable amount. One small
 * record per page costs nothing and keeps the figure honest.
 */
import { idbKey } from '~/utils/idbKeys'

/** One call to a model, as the provider reported it. */
export interface AiUse {
  /** When it was made, so rows can be ordered and dated. */
  at: number
  /**
   * Which page it was for — `ComicPage.id`, this browser's own name for the
   * page, which is its path.
   *
   * The name is not enough to file a row under, which is the whole reason both
   * are kept. A chapter with sub-folders honestly holds two `001.jpg`, and a
   * ledger keyed on the name would show one page's calls under the other and
   * add them into its total.
   */
  pageId: string
  /** The page as the reader names it, for a row somebody reads. */
  page: string
  /** The model's label rather than its id — this is a row somebody reads. */
  model: string
  /**
   * What the call was for, where it was not the ordinary page translation.
   *
   * There used to be one thing that spent a key, so a row saying which model
   * answered said everything there was to say. There are two now — a page, and
   * a region somebody painted with the Translate region brush — and they arrive
   * against the same model, on the same page, minutes apart, in a table that
   * would draw them identically. A run of four regions then reads as four page
   * translations, which is the one thing a bill has to be able to tell apart.
   *
   * Optional because it is a label rather than a fact about the call, and
   * because every row written before it existed is a page run: a ledger restored
   * from IndexedDB or carried in a project file has none of these, and absent
   * has to go on meaning what it has always meant.
   */
  what?: string
  input: number
  /**
   * Everything the model wrote, hidden reasoning included: OpenRouter's
   * `completion_tokens` counts the thinking, and it is billed at the output
   * rate, so splitting them in this column would invite adding them twice.
   */
  output: number
  /** The part of `output` that was thinking, kept for the total's footnote. */
  reasoning: number
  /** Null where the provider bills the account rather than saying per call. */
  cost: number | null
}

export interface AiTotals {
  calls: number
  input: number
  output: number
  reasoning: number
  cost: number
  /**
   * Calls the provider would not price. They are counted and their tokens are
   * counted, but they are missing from `cost` — so a total with any of these in
   * it is a floor, and the panel says so rather than presenting it as the bill.
   */
  unpriced: number
}

const NOTHING: AiTotals = { calls: 0, input: 0, output: 0, reasoning: 0, cost: 0, unpriced: 0 }

/**
 * How many calls are kept row by row. Two hundred is a long volume translated
 * page by page, which is the most anybody will scroll through.
 */
const MAX_ROWS = 200

interface Stored {
  entries: AiUse[]
  /** What the rows trimmed away added up to, by the page they belonged to. */
  carried: Record<string, AiTotals>
}

export const add = (into: AiTotals, use: AiUse): AiTotals => ({
  calls: into.calls + 1,
  input: into.input + use.input,
  output: into.output + use.output,
  reasoning: into.reasoning + use.reasoning,
  cost: into.cost + (use.cost ?? 0),
  unpriced: into.unpriced + (use.cost === null ? 1 : 0),
})

/**
 * Drop the oldest rows past the cap, keeping what they were worth.
 *
 * Pure and exported because it is the one piece of this file that can lose
 * money without anybody noticing. A page's total is its carried figure plus its
 * remaining rows, so a fold that dropped a row without banking it, or banked it
 * under the wrong page, would show a smaller bill than was actually paid — and
 * it would only start doing so on the two-hundred-and-first call, long after
 * anybody was watching.
 */
export function trim (
  entries: AiUse[],
  carried: Record<string, AiTotals>,
  max: number,
): { entries: AiUse[], carried: Record<string, AiTotals> } {
  if (entries.length <= max) return { entries, carried }

  const going = entries.slice(0, entries.length - max)
  const folded = { ...carried }

  for (const old of going) folded[old.pageId] = add(folded[old.pageId] ?? NOTHING, old)

  return { entries: entries.slice(going.length), carried: folded }
}

export function useAiUsage () {
  const route = useRoute()
  const { page } = useComic()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Beside the chapter's own record rather than in it — a log, not a source. */
  const key = computed(() => idbKey.usage(workspace.value))

  const entries = useState<AiUse[]>('ai-usage', () => [])
  const carried = useState<Record<string, AiTotals>>('ai-usage-carried', () => ({}))

  /** Which workspace the rows in hand belong to — see `useGlossary.held`. */
  const held = useState<string | null>('ai-usage-held', () => null)

  /**
   * The open page's calls, newest first.
   *
   * Empty rather than everything when no page is open: a panel with nothing on
   * screen to be about should show nothing, not the chapter.
   */
  const rows = computed(() => {
    const here = page.value?.id

    if (!here) return []

    return entries.value.filter((use) => use.pageId === here).sort((a, b) => b.at - a.at)
  })

  /** What the open page has cost — its trimmed rows included. */
  const total = computed(() => {
    const here = page.value?.id

    if (!here) return NOTHING

    return rows.value.reduce(add, carried.value[here] ?? NOTHING)
  })

  async function persist () {
    await idb.set(key.value, { entries: entries.value, carried: carried.value } satisfies Stored)
      .catch(() => {
        // A ledger that could not be written costs the record and nothing else.
        // The translation is on the page and the money is already spent, so
        // this is not worth interrupting anybody over.
      })
  }

  async function restore () {
    if (!workspace.value || held.value === workspace.value) return

    const asked = workspace.value
    const kept = await idb.get<Stored>(key.value).catch(() => undefined)

    // Another chapter was opened while this was being read.
    if (asked !== workspace.value) return

    entries.value = Array.isArray(kept?.entries) ? kept.entries : []
    carried.value = kept?.carried ?? {}
    held.value = asked
  }

  /**
   * Note a call. Everything on the row is the provider's own report, except the
   * page and the model's name, which it has no way of knowing.
   */
  async function record (use: AiUse) {
    // Oldest out, and what they were worth kept — under the page each belonged
    // to, so that page's total is unchanged by its rows ageing out.
    const next = trim([...entries.value, use], carried.value, MAX_ROWS)

    entries.value = next.entries
    carried.value = next.carried

    await persist()
  }

  /** Start the ledger again, for this chapter. */
  async function clear () {
    entries.value = []
    carried.value = {}

    await idb.del(key.value).catch(() => {})
  }

  // A different chapter is a different ledger, and the old one must not sit on
  // screen while this one is read back.
  watch(workspace, () => {
    entries.value = []
    carried.value = {}
    held.value = null
    restore()
  })

  return { entries, rows, total, restore, record, clear }
}
