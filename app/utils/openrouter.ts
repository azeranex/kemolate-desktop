/**
 * Translating a page through OpenRouter, from the browser.
 *
 * From the browser for the same reason Vision is — see `app/utils/vision.ts` —
 * and here the argument is sharper rather than weaker. A vision model is sent
 * the *page image* along with the text, which is exactly the "AI · Image"
 * engine in the toolbar. Routing that through our server would mean uploading
 * every scan after all, by a different door. So the request goes straight out,
 * on the reader's own key.
 *
 * OpenRouter is designed to be called this way and asks for `HTTP-Referer` and
 * `X-Title` so it can attribute the traffic; the browser sets the first itself
 * and refuses to let script forge it, which is fine — that is what it is for.
 *
 * What the model is *asked* lives in `shared/utils/prompt.ts`. This file is
 * only the errand, and the split is deliberate: the prompt is the part worth
 * reading, and it should not cost a request to read it.
 */
import { jobKey, scanJob } from '~/utils/raster/decoder'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Reasoning models spend most of a generous budget before they answer, so a
 * limit sized for the reply alone truncates them mid-thought.
 */
const MAX_TOKENS = 16_000

/** Long, because a page of reasoning against a slow model genuinely takes minutes. */
const TIMEOUT = 300_000

/**
 * How many times one ask is sent again after a refusal that passes — a rate
 * limit, a provider's 5xx, a connection that dropped.
 *
 * Nothing was retried, so one 502 in the middle of a chapter stopped the run at
 * that page for a condition that was gone a second later. Two more tries and
 * then the error stands exactly as it did: "a refusal ends the run" (see
 * `useAutoRun`) is right for what persists, and a provider still refusing after
 * three asks is, as far as this page can tell, something that persists.
 *
 * What is never retried is decided by what it means rather than by how often
 * it happens: a rejected key, no credit, a bad request or a retired model all
 * answer the same way every time, and a timeout has already cost five minutes
 * of somebody's afternoon.
 */
const RETRIES = 2

/** How long to wait before each retry where the provider does not say. */
const BACKOFF = [2_000, 6_000]

/**
 * The longest a `Retry-After` is taken at its word. A provider asking for an
 * hour is a provider that will not be answering this run, and a run frozen for
 * an hour with no word on screen reads as a hang — so it gets this long, and
 * then the same refusal it would have got anyway.
 */
const MAX_WAIT = 30_000

/**
 * The patience the asks of one run share.
 *
 * A run has three pages out at once now (see `useTranslate`), and a rate limit
 * is the provider talking about all of them: it counts this key's requests, not
 * one page's. Left to themselves the three each took their refusal, each waited
 * its own backoff, and each came back at about the same moment to be refused
 * together again — three tries apiece spent in lock-step, and the run ended on a
 * limit that one polite pause would have cleared. So a 429 on any of them holds
 * *every* ask of the run, including the ones not yet sent, for as long as the
 * provider asked (`until`); and it marks the run `limited`, which `useTranslate`
 * reads as "one page at a time from here on" — the pace every run had before,
 * and the one a provider that has said "too many" once is owed.
 *
 * Only the 429. A 5xx or a dropped connection is about one request, and the
 * retries below still treat it as that request's alone.
 *
 * Owned by the run rather than kept here, so it ends with the run: a limit hit
 * yesterday is not this press's business, and nothing about a key's traffic is
 * held past the asks that made it.
 */
export interface RateGate {
  /** When the provider may next be asked, as a time. */
  until: number
  /** Whether it has said "too many" during this run. */
  limited: boolean
}

/*
 * What the curated list cannot know until it asks — which models accept a
 * `reasoning` parameter, and what they actually charge — is `useModels`, not
 * here. It lived in this file as `refreshModels()`, rewriting `AI_MODELS` in
 * place; that array is not reactive and the panel had already copied the
 * placeholder prices out of it at setup, so the function changed nothing on
 * screen and nothing ever called it. See `useModels` for the whole of that.
 */

/** What one page cost, as far as the provider will say. */
export interface AiUsage {
  input: number
  output: number
  /** Part of `output` spent on hidden reasoning, billed at output rates. */
  reasoning: number
  /** Null where the provider bills the account rather than reporting per call. */
  cost: number | null
}

export interface TranslateInput extends PromptInput {
  model: AiModel
  effort?: ReasoningEffort
  /**
   * The page, for a model that can see. Resized before it gets here — a scan is
   * several thousand pixels wide and none of that reaches the model anyway.
   */
  image?: Blob | null
  /**
   * Told how long the ask is about to wait before trying again — see `RETRIES`.
   * A wait of up to half a minute inside a request that already takes minutes
   * is otherwise indistinguishable from a model thinking hard.
   */
  retrying?: (wait: number) => void
  /** The run this ask belongs to, whose rate limits it shares — see `RateGate`. */
  gate?: RateGate
}

export interface Translated {
  /**
   * One per block, in the order they were sent — and always a string. Where
   * the model wrote something that is not a line at all, the string is empty
   * and its position is in `unreadable`.
   */
  translations: string[]
  /** Positions in `translations` the model answered with something unreadable. */
  unreadable: number[]
  /** The language the model decided it was reading, as an ISO 639-1 code. */
  source: string | null
  usage: AiUsage | null
  /** Terms the model thought worth keeping for later pages. */
  learnedTerms: { src?: string, tr?: string }[]
  /** People the page introduced. */
  learnedCast: { name?: string, tr?: string, gender?: string, tags?: string[] }[]
}

/** The longest edge a page is sent at. Beyond this is detail no model reads. */
export const IMAGE_MAX_EDGE = 1000

/**
 * Shrink a page to something worth sending.
 *
 * A scan is often four thousand pixels on its long edge, which is a megabyte or
 * two of base64 for detail the model cannot use. Done on a canvas rather than
 * with an image library, because the browser already has one and this is the
 * only resizing the app needs.
 */
export async function shrinkForModel (file: Blob, maxEdge = IMAGE_MAX_EDGE): Promise<Blob> {
  // On the background thread: drawing a four-thousand-pixel page down is a
  // frame of 50 ms wherever it runs, and here it ran on the page's. The full
  // decode it needs is let go there, so a chapter's worth cannot accumulate.
  const made = await scanJob(jobKey('model'), file, { what: 'model', maxEdge, type: 'image/jpeg', quality: 0.85 })

  return made?.blob ?? file
}

/** Base64 without the `data:` preamble. */
function encode (blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(reader.error ?? new Error('The page could not be read.'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(blob)
  })
}

/**
 * A picture, as a message part.
 *
 * The blob's **own** type rather than a hard-coded `image/jpeg`, which is what
 * this used to say. It was true of everything that went through here while a
 * page was the only thing that did — `shrinkForModel` re-encodes as JPEG — and
 * it stops being true twice over: a scan already inside the bound is passed
 * through untouched, and a *region* is cut out as PNG on purpose, because JPEG
 * ringing around high-contrast edges is precisely the artefact that turns one
 * character into another (see `cropOut`). Either way the bytes are PNG and the
 * label said JPEG, which providers are entitled to refuse and some do.
 */
async function pictureOf (blob: Blob) {
  const type = blob.type || 'image/jpeg'

  return { type: 'image_url', image_url: { url: `data:${type};base64,${await encode(blob)}` } }
}

/** What comes back from any one ask, before anybody reads it as JSON. */
interface Answer {
  text: string
  usage: AiUsage | null
}

/**
 * How long a refusal asked to be left alone, in milliseconds, or null where it
 * did not say. Seconds or an HTTP date — the header allows either.
 */
function retryAfter (response: Response): number | null {
  const said = response.headers.get('retry-after')?.trim()

  if (!said) return null
  if (/^\d+(?:\.\d+)?$/.test(said)) return Number(said) * 1000

  const at = Date.parse(said)

  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/** A provider saying "not now" rather than "no". */
const passing = (status: number) => status === 429 || status >= 500

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * One request, and everything that can go wrong with one.
 *
 * Both asks here — translate a page, read a region — differ only in what they
 * put in the message and what they make of the reply. The errand between those
 * two is identical, and it is the part with the accumulated knowledge in it: the
 * timeout that has to be minutes rather than seconds, the two status codes worth
 * naming, the usage block, the retries and the fallback below. Written twice it
 * would have been two of each, and the second copy would have been the one
 * missing a retry.
 *
 * The fallback: some endpoints refuse a reasoning setting outright — "Reasoning
 * is mandatory for this endpoint" and its opposite both exist — and falling back
 * to the model's own default is better than failing over a knob nobody turned
 * deliberately. It is not one of the retries: the request is a different one,
 * the refusal is not transient, and it can only happen once.
 *
 * The retries are `RETRIES`, and cover a rate limit, a 5xx and a dropped
 * connection — never a timeout, a key, credit, or a request the provider has
 * said it will not take. A connection dropped after the request arrived may be
 * one the provider billed, and asking again pays twice; that is the price of
 * not ending a chapter's run on a blip, and it is paid only where the
 * alternative was ending it.
 *
 * A rate limit is also said to the rest of the run, through its `gate`, and
 * every send — first or again — waits out whatever hold the gate carries.
 */
async function ask (
  key: string,
  input: { model: AiModel, content: unknown, effort: ReasoningEffort, retrying?: (wait: number) => void, gate?: RateGate },
): Promise<Answer> {
  let effort = input.effort
  let retries = 0

  /** Wait before going round again — or false, where the tries are spent. */
  const again = async (asked: number | null, status?: number): Promise<boolean> => {
    if (retries >= RETRIES) return false

    const wait = Math.min(asked ?? BACKOFF[retries] ?? MAX_WAIT, MAX_WAIT)

    retries += 1

    // Before the wait, so an ask of the same run about to go out holds for it
    // too rather than walking into the same refusal — see `RateGate`.
    if (status === 429 && input.gate) {
      input.gate.until = Math.max(input.gate.until, Date.now() + wait)
      input.gate.limited = true
    }

    input.retrying?.(wait)
    await pause(wait)

    return true
  }

  for (;;) {
    // Behind a hold another ask of this run was given. Said like a retry,
    // because to the reader it is one: the provider could not take this now.
    const held = (input.gate?.until ?? 0) - Date.now()

    if (held > 0) {
      input.retrying?.(held)
      await pause(held)
    }

    let response: Response

    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'kemolate',
        },
        body: JSON.stringify({
          model: input.model.id,
          max_tokens: MAX_TOKENS,
          usage: { include: true },
          ...(effort === 'auto' ? {} : { reasoning: { effort } }),
          messages: [{ role: 'user', content: input.content }],
        }),
      })
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError'

      if (!timedOut && await again(null)) continue

      throw new Error(
        timedOut
          ? `${input.model.label} took too long to answer. A smaller effort setting usually helps.`
          : `Could not reach OpenRouter. ${error instanceof Error ? error.message : String(error)}`,
        // The sentence above is for the reader; this keeps the original for
        // whoever has to work out whether it was the network or the provider.
        { cause: error },
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('OpenRouter rejected the API key — check it in settings.')
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')

      if (response.status === 400 && effort !== 'auto' && /reasoning/i.test(body)) {
        effort = 'auto'

        continue
      }

      if (passing(response.status) && await again(retryAfter(response), response.status)) continue

      throw new Error(`OpenRouter error ${response.status}: ${body.slice(0, 300)}`)
    }

    const data = await response.json() as {
      choices?: { message?: { content?: string }, finish_reason?: string | null }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        cost?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
      error?: { message?: string }
    }

    if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? 'unknown error'}`)

    const choice = data.choices?.[0]

    /*
     * Cut off at the token limit, which is not an answer however it reads.
     *
     * It used to be taken for one. A reply stopped mid-sentence is almost always
     * broken JSON, which surfaced as "not JSON — try again" (and trying again
     * stops at the same place), while the rare one that happened to parse was a
     * page with its last lines missing, applied as if whole. Asked before the
     * text is, because a reasoning model that spent the entire budget thinking
     * comes back with no text at all, and "no output" is the wrong diagnosis
     * of that too.
     */
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `${input.model.label}'s answer was cut off at the ${MAX_TOKENS.toLocaleString('en')}-token limit, so none of it was used. A lower effort setting leaves more of that for the answer itself.`,
      )
    }

    const text = choice?.message?.content

    if (!text) throw new Error('The model returned no output.')

    return {
      text,
      usage: data.usage
        ? {
            input: data.usage.prompt_tokens ?? 0,
            output: data.usage.completion_tokens ?? 0,
            reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            cost: data.usage.cost ?? null,
          }
        : null,
    }
  }
}

export interface RegionInput extends RegionPromptInput {
  model: AiModel
  /** The region, cut out of the page. Shrunk here if it needs it. */
  image: Blob
  effort?: ReasoningEffort
}

export interface RegionRead {
  /** The lettering, exactly as the model read it off the picture. */
  source: string
  /** And what it should say instead. */
  translation: string
  /** The language the model decided it was reading, as an ISO 639-1 code. */
  language: string | null
  usage: AiUsage | null
  /** Terms the model thought worth keeping for later pages. */
  learnedTerms: { src?: string, tr?: string }[]
  /** People the region introduced. */
  learnedCast: { name?: string, tr?: string, gender?: string, tags?: string[] }[]
}

/**
 * Why this model cannot be asked to read a picture, or null where it can.
 *
 * A sentence rather than a boolean, and exported, because two places need to
 * refuse and they refuse at different moments: `readRegion` before it makes the
 * block, so a wrong model costs a sentence instead of an empty box, and
 * `readImage` at the door, so no caller can reach the request without passing
 * it. Written once so the two cannot come to say different things about the
 * same model.
 */
export function cannotSee (model: AiModel): string | null {
  return model.vision
    ? null
    : `${model.label} cannot see pictures — pick a model that can, in the Translate panel.`
}

/**
 * Have the model read one region of a page and carry it over, in one ask.
 *
 * The Translate region brush, whole. See `regionPrompt` for why both halves are
 * one request rather than two, and why the reading is asked for first.
 *
 * A model that cannot see is refused here rather than sent a message with no
 * picture in it. That failure is silent and expensive in the way that matters:
 * the reply is fluent, invented, and indistinguishable from a reading.
 *
 * Both fields are required of the reply, and a missing one is refused rather
 * than defaulted. `translation` alone would leave the block claiming an empty
 * source — which downstream is not "unknown" but "nothing was printed here" —
 * and `source` alone would land a block that looks translated because the
 * lettering plate has something to draw.
 */
export async function translateRegion (key: string, input: RegionInput): Promise<RegionRead> {
  const blind = cannotSee(input.model)

  if (blind) throw new Error(blind)

  const image = await shrinkForModel(input.image)

  const { text, usage } = await ask(key, {
    model: input.model,
    effort: input.effort ?? 'auto',
    content: [await pictureOf(image), { type: 'text', text: regionPrompt(input) }],
  })

  const parsed = jsonFrom(text) as {
    source_language?: string
    source?: unknown
    translation?: unknown
    glossary?: unknown
    cast?: unknown
  }

  if (typeof parsed.source !== 'string' || typeof parsed.translation !== 'string') {
    throw new Error('The model returned unexpected JSON — try again.')
  }

  return {
    source: parsed.source,
    translation: parsed.translation,
    language: parsed.source_language || null,
    usage,
    learnedTerms: Array.isArray(parsed.glossary) ? parsed.glossary : [],
    learnedCast: Array.isArray(parsed.cast) ? parsed.cast : [],
  }
}

export interface ShortenInput extends ShortenPromptInput {
  model: AiModel
  effort?: ReasoningEffort
}

export interface Shortened {
  /** The shorter line, cleaned of any wrapping quotes — never empty. */
  text: string
  usage: AiUsage | null
}

/**
 * Ask for one line again in fewer characters — see `shortenPrompt`.
 *
 * Text only, whatever the engine: the question is one of length, and the page
 * image would cost more than the rest of the request to answer something the
 * draft already settled. So a model that cannot see is asked this as readily
 * as one that can.
 *
 * An empty answer is refused here rather than handed back, because every
 * caller would otherwise have to remember that "" is not a line — and the one
 * that forgot would blank a balloon somebody had lettered.
 */
export async function shortenLine (key: string, input: ShortenInput): Promise<Shortened> {
  const { text, usage } = await ask(key, {
    model: input.model,
    effort: input.effort ?? 'auto',
    content: shortenPrompt(input),
  })

  const line = shortLineFrom(text, input.translation)

  if (!line) throw new Error(`${input.model.label} did not answer with a line — try again.`)

  return { text: line, usage }
}

/**
 * One element of a reply's `translations`, as the line it is — or null where it
 * is not a line at all.
 *
 * Only the list itself used to be checked, so an element that was not a string
 * went straight through to `useTranslate`, where `.trim()` threw on it: the run
 * stopped over one line, after the page had been paid for. A model that writes
 * a number, or wraps a line in `{"text": …}`, has plainly said something, and
 * this reads it as what it said. Anything else — null, a list, an object with
 * no text — is a line it did not write: left empty, counted in `unreadable`,
 * and so reported rather than guessed at. A string comes through untouched,
 * which is every element of every good reply.
 */
function lineOf (element: unknown): string | null {
  if (typeof element === 'string') return element
  if (typeof element === 'number' && Number.isFinite(element)) return String(element)

  if (typeof element === 'object' && element !== null && 'text' in element && typeof element.text === 'string') {
    return element.text
  }

  return null
}

/**
 * Translate a page.
 *
 * The errand itself — the timeout, the two status codes worth naming, the
 * retries, the reasoning fallback, a reply cut off — is `ask`, shared with the
 * region reading. What is left here is what makes this ask a translation: the
 * prompt, the count, and reading each line as one.
 */
export async function translatePage (
  key: string,
  input: TranslateInput,
): Promise<Translated> {
  const image = input.image && input.model.vision ? await shrinkForModel(input.image) : null
  const prompt = pagePrompt({ ...input, hasImage: Boolean(image) })

  const content = image ? [await pictureOf(image), { type: 'text', text: prompt }] : prompt

  const { text, usage } = await ask(key, {
    model: input.model,
    effort: input.effort ?? 'auto',
    content,
    retrying: input.retrying,
    gate: input.gate,
  })

  const parsed = jsonFrom(text) as {
    source_language?: string
    translations?: unknown
    glossary?: unknown
    cast?: unknown
  }

  if (!Array.isArray(parsed.translations)) {
    throw new Error('The model returned unexpected JSON — try again.')
  }

  /*
   * The single-block ask promises exactly one line back, and a model that
   * ignores the instruction and answers for the whole page is the dangerous
   * miscount rather than the harmless one: `translations[0]` is then block
   * one's line, and applying it would put another balloon's words into the
   * block that was asked about — silently, and then persisted. So anything but
   * one is refused outright here, where every caller of the ask benefits. The
   * page-run path deliberately tolerates a short list instead: its lines are
   * positional, so what did come back still lands where it belongs.
   */
  const one = input.only !== undefined && input.only >= 0 && input.only < input.blocks.length

  if (one && parsed.translations.length !== 1) {
    throw new Error(
      `${input.model.label} answered for ${parsed.translations.length} blocks where one was asked — try again.`,
    )
  }

  const lines = parsed.translations.map(lineOf)

  return {
    translations: lines.map((line) => line ?? ''),
    unreadable: lines.flatMap((line, index) => (line === null ? [index] : [])),
    source: parsed.source_language || null,
    usage,
    learnedTerms: Array.isArray(parsed.glossary) ? parsed.glossary : [],
    learnedCast: Array.isArray(parsed.cast) ? parsed.cast : [],
  }
}
