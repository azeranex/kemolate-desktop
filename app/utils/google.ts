/**
 * The free Google endpoint, called from the browser.
 *
 * Ported from the earlier build's `gtxTranslate`, where it was the fallback
 * that made the app usable before anybody had entered a key — and it is still
 * that. No key, no account, no cost: what it gives up is context, because it
 * translates one string at a time and cannot be told that the string before it
 * was the same person talking.
 *
 * From the browser rather than through our server, for the reason everything
 * else in this pipeline runs here: `translate.googleapis.com` answers with
 * `access-control-allow-origin: *`, so there is nothing for a proxy to solve,
 * and a proxy would put the reader's lettering through our machines for no gain.
 *
 * This is an undocumented endpoint that Google may withdraw. That is priced in:
 * one line's own failure comes back as an empty line rather than a thrown run
 * — counted, so the caller can say how many — and a page where *every* line
 * came back empty says the service could not be reached. The one failure that
 * *does* throw is a rate limit, because a 429 is the endpoint talking about
 * the run rather than about any line: pressing on just feeds more requests
 * into the same refusal and reads back as a page of silent gaps.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single'

/** One line is a phrase, not a chapter; anything longer is not a comic block. */
const MAX_CHARS = 2_000

/** Slow enough for a hiccup, fast enough that a dead endpoint is not a hang. */
const TIMEOUT = 20_000

/**
 * How many lines are in the air at once.
 *
 * The endpoint is one call per block, so a page of thirty is thirty calls;
 * unthrottled they go out together and the whole page comes back rate-limited
 * as one. Eight is the earlier build's number and it has never been the
 * bottleneck — a page finishes in about the time one call takes.
 */
const CONCURRENCY = 8

/**
 * Our language codes as Google spells them.
 *
 * Only the ones that differ, which is the point of it being a lookup rather
 * than a translation table: everything absent is already right. `zh` alone is
 * ambiguous to Google and it guesses; `pt` alone is Brazilian, which is the
 * opposite of what our `pt` means; and Filipino is `tl` there.
 */
const GOOGLE_CODE: Record<string, string> = {
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  'pt-BR': 'pt',
  pt: 'pt-PT',
  fil: 'tl',
}

/** What one line came back as, and what Google decided it was reading. */
export interface GoogleLine {
  text: string
  /** An ISO 639-1 code, or null where Google would not say. */
  source: string | null
}

/**
 * An HTTP refusal, with its status carried where a catch can read it. A rate
 * limit has to be tellable from every other failure — it is the one that must
 * stop a run rather than be retried into — and parsing it back out of an
 * error message is how that check silently breaks when the wording changes.
 */
const refusal = (status: number) =>
  Object.assign(new Error(`Google Translate answered ${status}.`), { status })

const statusOf = (thrown: unknown): number | undefined =>
  typeof thrown === 'object' && thrown !== null && 'status' in thrown && typeof thrown.status === 'number'
    ? thrown.status
    : undefined

/** What a 429 reads as to the person whose run it stopped. */
const limited = () => Object.assign(
  new Error('Google Translate is rate-limiting this browser — wait a moment and try again, or switch to an AI engine.'),
  { status: 429 },
)

/**
 * One line.
 *
 * The reply is a positional array — `[[[translated, original, …], …], …,
 * detected]` — with no names on anything, which is why it is read defensively
 * rather than typed. Long lines come back split into segments and are joined
 * back up in the order they were given.
 */
export async function googleTranslate (text: string, locale: string): Promise<GoogleLine> {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: GOOGLE_CODE[locale] ?? locale,
    dt: 't',
    q: text.slice(0, MAX_CHARS),
  })

  const response = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(TIMEOUT) })

  if (!response.ok) throw refusal(response.status)

  const data = await response.json() as [[string?][]?, unknown?, unknown?]
  const segments = Array.isArray(data[0]) ? data[0] : []
  const detected = data[2]

  return {
    text: segments.map((segment) => segment?.[0] ?? '').join(''),
    source: typeof detected === 'string' && detected !== 'und' ? detected : null,
  }
}

/**
 * How much source goes in one batched request.
 *
 * The whole thing travels in a query string, and a URL has a practical ceiling
 * no error message will tell you about — an over-long one comes back as a bare
 * 400 or a truncated translation. Well under it, and a page of comic lettering
 * is usually one chunk anyway.
 */
const CHUNK_CHARS = 1_500

/**
 * A page's worth of lines, batched.
 *
 * ## One request, not thirty
 *
 * Google segments a `q` on newlines and answers with one segment per line, so a
 * page can go in one call. Measured against this endpoint, twelve lines took
 * **1028 ms one at a time and 55 ms batched** — and, which matters more than
 * the speed, it is one chance to be rate-limited rather than twelve.
 *
 * Note that the multiple-`q` form does *not* work here despite being the
 * obvious way: `&q=a&q=b` silently answers for `a` alone, which would have
 * looked like a page where every line after the first came back empty.
 *
 * ## It buys nothing in quality, and that is worth knowing
 *
 * Batching is a speed change and only a speed change. Google splits on the
 * newlines and translates each line in isolation, so lines still cannot lean on
 * each other: `私は` / `あなたのことが` / `好きです` — one sentence across three
 * balloons — comes back "I am" / "about you" / "I like it" whether it is sent
 * as one request or three. If a page needs its lines read together, that is
 * what the AI engines are for; no arrangement of this endpoint will do it.
 *
 * ## Why the answer is counted before it is trusted
 *
 * The one thing that breaks the batch is a **newline inside a block's own
 * source**, which vertical lettering produces readily. Sent as `あの\nひと`
 * inside a batch, Google returns four segments for three lines — and every
 * translation after it lands on the wrong balloon, silently, for the rest of
 * the page. So the newlines are collapsed out on the way in *and* the segment
 * count is checked on the way back; a chunk that does not match falls back to
 * one call per line, which cannot desync because nothing is being aligned.
 */
export async function googleTranslateAll (
  texts: string[],
  locale: string,
  onLine?: (done: number, total: number) => void,
): Promise<{ translations: string[], source: string | null, failed: number }> {
  const translations = new Array<string>(texts.length).fill('')
  const votes = new Map<string, number>()

  let done = 0
  let failed = 0

  const vote = (source: string | null) => {
    if (source) votes.set(source, (votes.get(source) ?? 0) + 1)
  }

  /**
   * One line at a time — the fallback, and what a failed batch degrades to.
   *
   * `width` is how many at once, and it is a parameter because the two callers
   * degrade for different reasons: a batch that *answered* and merely
   * miscounted can be re-asked at full width, but a batch the endpoint refused
   * must not be — eight parallel retries of a request that just failed is one
   * refusal amplified into nine, against an endpoint nobody pays for.
   */
  async function oneByOne (indexes: number[], width = CONCURRENCY) {
    let next = 0
    let halted = false

    const worker = async () => {
      for (let at = next++; at < indexes.length && !halted; at = next++) {
        const index = indexes[at]!

        try {
          const line = await googleTranslate(texts[index]!, locale)

          translations[index] = line.text
          vote(line.source)
        } catch (thrown) {
          // A rate limit is the endpoint talking about the run, not this line:
          // pressing on feeds the remaining lines into the same refusal and
          // reads back as a page of silent gaps. Everything else is one line's
          // own failure — a gap in the page, counted so the caller can say so
          // rather than leave a balloon that looks forgotten.
          if (statusOf(thrown) === 429) {
            halted = true

            throw limited()
          }

          failed += 1
        }

        onLine?.(++done, texts.length)
      }
    }

    await Promise.all(Array.from({ length: Math.min(width, indexes.length) }, worker))
  }

  /** As many lines as fit in one request, by source length. */
  const chunks: number[][] = []

  let chunk: number[] = []
  let size = 0

  for (const [index, text] of texts.entries()) {
    const length = Math.min(text.length, MAX_CHARS)

    if (chunk.length && size + length > CHUNK_CHARS) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }

    chunk.push(index)
    size += length
  }

  if (chunk.length) chunks.push(chunk)

  for (const indexes of chunks) {
    // A single line is a batch of one, where the count check is trivially true
    // and the collapse is the only thing that matters. Sent as itself rather
    // than through the batch path so nothing is joined or split at all.
    if (indexes.length === 1) {
      await oneByOne(indexes)
      continue
    }

    // Collapsed, not trimmed away: the alignment depends on there being exactly
    // one newline between lines and none within them.
    const joined = indexes.map((index) => oneLine(texts[index]!)).join('\n')

    let refused: unknown = null

    const answer = await batch(joined, locale).catch((thrown: unknown) => {
      refused = thrown

      return null
    })

    // A rate limit on the batch is a rate limit on everything after it.
    // Re-asking the same lines one at a time would send a stack of new
    // requests into an endpoint that just said stop — the failure would come
    // back as a page of empty balloons and the reader would press again.
    if (statusOf(refused) === 429) throw limited()

    const segments = answer?.lines ?? null

    // The count is the whole guard. Anything but an exact match and this chunk
    // is re-asked a line at a time, where a miscount cannot put one balloon's
    // words in another — at full width when the endpoint answered and merely
    // miscounted, one at a time when it refused outright.
    if (!segments || segments.length !== indexes.length) {
      await oneByOne(indexes, refused ? 1 : CONCURRENCY)
      continue
    }

    for (const [at, index] of indexes.entries()) translations[index] = segments[at]!.trim()

    vote(answer?.source ?? null)
    done += indexes.length
    onLine?.(done, texts.length)
  }

  const source = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return { translations, source, failed }
}

/** A block's source as one line, so a batch's newlines mean only what they should. */
const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ').slice(0, MAX_CHARS)

/** Several lines in one request, split back on the newlines Google keeps. */
async function batch (joined: string, locale: string): Promise<{ lines: string[], source: string | null }> {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: GOOGLE_CODE[locale] ?? locale,
    dt: 't',
    q: joined,
  })

  const response = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(TIMEOUT) })

  if (!response.ok) throw refusal(response.status)

  const data = await response.json() as [[string?][]?, unknown?, unknown?]
  const detected = data[2]

  /*
   * The segments come back one per line with the newline still attached, so
   * joining them and splitting again is the same operation Google performed —
   * and is safer than trusting the segment array to be one-per-line, which it
   * is not obliged to be. A long line can arrive as two segments with no break
   * between them, and re-splitting puts it back together.
   */
  const whole = (Array.isArray(data[0]) ? data[0] : []).map((segment) => segment?.[0] ?? '').join('')

  return {
    lines: whole.split('\n'),
    source: typeof detected === 'string' && detected !== 'und' ? detected : null,
  }
}
