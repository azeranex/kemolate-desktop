/**
 * The models on offer, in one place.
 *
 * Ported from the earlier build's `AI_MODELS`, which is a curated list rather
 * than a catalogue: OpenRouter carries hundreds and most of them are wrong for
 * this — a page of comic lettering wants something that reads pictures well,
 * writes natural dialogue, and does not cost a fortune over two hundred pages.
 * These are the ones that do.
 *
 * **Not every one of them can see.** That used to be true and was written here
 * as a standing fact — "both AI engines work with any of them" — which stopped
 * being so the moment DeepSeek was added: its V4 line is text-only, and it
 * earns its place on price and on Chinese rather than on reading artwork. So
 * `vision` is a real question to ask of an entry rather than a field that is
 * always true, and the AI · Image engine is offered only for the models that
 * can answer it. `useModels.refresh()` re-reads it from OpenRouter, so a model
 * that gains sight — or an entry written down wrong here — corrects itself.
 *
 * Shared because three things ask: the picker offers them, the browser calls
 * one, and the server will too once text translation moves there. It used to be
 * three separate lists that disagreed with each other, which is exactly the
 * failure a shared module is for.
 *
 * The ids are OpenRouter's, vendor prefix and all, because that is what gets
 * sent. Talking to a provider directly would need its own list — Anthropic does
 * not call it `anthropic/claude-sonnet-5.5` — and that is a good reason not to
 * quietly strip the prefix here.
 */

export interface AiModel {
  /** OpenRouter's id, which is what the request carries. */
  id: string
  label: string
  /** A line about when to reach for it, for the picker. */
  note: string
  /**
   * Desktop: the family this entry stands for, where it should always be that
   * family's newest version — `anthropic/claude-sonnet` for every Claude Sonnet.
   * `useModels.refresh()` moves the entry to the newest id the catalogue has
   * (`newestIn`), and a saved choice of an older version follows it
   * (`familyOf`). The id written here is the newest known when the list was
   * last brought up to date, which is what is used offline.
   */
  family?: string
  /**
   * Desktop: one of OpenRouter's free models (an id ending `:free`), offered
   * from its catalogue rather than written here — see `useModels.refresh` and
   * `isFreeModel`.
   */
  free?: boolean
  /** Whether it can be shown the page as well as told about it. */
  vision: boolean
  /**
   * Whether it accepts a reasoning setting. Unknown until asked — see
   * `useModels` — and the effort control stays hidden while it is.
   */
  reasoning?: boolean
  /**
   * US dollars per million tokens, in and out.
   *
   * The numbers below are placeholders of the right order of magnitude, so a
   * cost estimate reads as roughly the right size before anything has been
   * asked. `useModels.refresh()` replaces them with what OpenRouter actually
   * charges, which is the only version worth quoting to somebody about to spend
   * money — and until it has run, a panel showing these should say so rather
   * than presenting an invented number as a price.
   */
  price: { in: number, out: number }
}

/**
 * Best all-round first within each family, then the one for hard pages, then
 * the cheap one — and the families in the order most people reach for them.
 *
 * Brought up to date on 2026-09-30 against OpenRouter's catalogue, prices and
 * all. A family moves on by its id changing (`claude-sonnet-5` →
 * `claude-sonnet-5.5`), and a reader whose saved choice is an id no longer here
 * is moved to its successor (`SUCCESSORS`, below) rather than sent to a
 * retired one — see `remember('kemolate:translate', …)` in `useComic`.
 */
export const AI_MODELS: AiModel[] = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    family: 'anthropic/claude-sonnet',
    label: 'Claude Sonnet 5.5',
    note: 'Best all-round for a whole volume',
    vision: true,
    price: { in: 2, out: 10 },
  },
  {
    id: 'anthropic/claude-opus-5.5',
    family: 'anthropic/claude-opus',
    label: 'Claude Opus 5.5',
    note: 'Hardest lines, most of the page held in mind',
    vision: true,
    price: { in: 4, out: 20 },
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    family: 'anthropic/claude-haiku',
    label: 'Claude Haiku 5.5',
    note: 'Quick passes and plain dialogue',
    vision: true,
    price: { in: 1, out: 5 },
  },
  {
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    note: 'Strong all-round, quick',
    vision: true,
    price: { in: 0.75, out: 3.75 },
  },
  /*
   * A preview id, because that is the only one the Pro line has on OpenRouter.
   * Previews are retired rather than renamed, and a retired id here falls back
   * to the first entry for anybody who had chosen it — so this is worth
   * re-checking whenever the list is next brought up to date.
   */
  {
    id: 'google/gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    note: 'Google’s strongest — careful on a hard page',
    vision: true,
    price: { in: 2, out: 12 },
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    note: 'Cheap, for long runs',
    vision: true,
    price: { in: 0.3, out: 2.5 },
  },
  {
    id: 'google/gemma-4-31b-it',
    label: 'Gemma 4 31B',
    note: 'Open model that can see, very cheap',
    vision: true,
    price: { in: 0.09, out: 0.34 },
  },
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    note: 'Strong all-round',
    vision: true,
    price: { in: 2, out: 10 },
  },
  {
    id: 'openai/gpt-6-astra',
    label: 'GPT-6 Astra',
    note: 'OpenAI’s strongest, priced like it',
    vision: true,
    price: { in: 10, out: 50 },
  },
  {
    id: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna',
    note: 'Very cheap',
    vision: true,
    price: { in: 0.1, out: 0.5 },
  },
  {
    id: 'qwen/qwen3.8-flash',
    label: 'Qwen3.8 Flash',
    note: 'Cheap and can see, strong on CJK',
    vision: true,
    price: { in: 0.15, out: 0.47 },
  },
  /*
   * DeepSeek, and why two of its three are here without eyes.
   *
   * The V4 line cannot be shown a page — it takes text and nothing else — so
   * AI · Image is not offered while one of those is chosen. V4.1 Flash is the
   * first of the family that can see, and is listed beside them rather than in
   * their place, because what the text-only pair bring is price and Chinese,
   * which is the source language of most of what gets translated here: V4
   * Flash is some twenty times cheaper per page than Sonnet.
   *
   * That is a real trade rather than a cheaper version of the same thing. A
   * vision model reads hand-drawn sound effects, works out who is speaking from
   * the artwork, and catches a line the detector cut in half. The text-only
   * ones do none of that and translate what OCR hands them, which for a page of
   * ordinary balloons is most of the job.
   *
   * Floating ids rather than dated snapshots (`deepseek-v4-flash`, not
   * `deepseek-v4-flash-0731`), matching every other entry here: this list is
   * curated by family, and pinning a date would freeze the family at whatever
   * day it was added.
   */
  {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    note: 'Cheap, can see — strong Chinese',
    vision: true,
    price: { in: 0.3, out: 1.2 },
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    note: 'Very cheap, text only — strong Chinese',
    vision: false,
    price: { in: 0.14, out: 0.28 },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    note: 'Text only, but reasons hard on a hard page',
    vision: false,
    price: { in: 0.96, out: 1.91 },
  },
]

export const DEFAULT_MODEL = AI_MODELS[0]!.id

/**
 * Ids that have left the list, and the entry that took each one's place.
 *
 * A reader's model is remembered between sessions, and without this a family
 * moving on put everybody back on the first entry: somebody who had chosen Opus
 * for a hard volume came back to Sonnet, and somebody on the cheapest model
 * for a long run came back to one that costs twenty times as much — with the
 * picker as the only place it said so. The successor is the same family at the
 * same rung, which is the choice they had actually made.
 *
 * Add a line here whenever an entry is replaced rather than removed.
 */
const SUCCESSORS: Record<string, string> = {
  'anthropic/claude-sonnet-5': 'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5': 'anthropic/claude-opus-5.5',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-5.5',
  'google/gemini-3.6-flash': 'google/gemini-3.8-flash',
  'openai/gpt-5.6-terra': 'openai/gpt-6.1-sol',
  'openai/gpt-5.6-luna': 'openai/gpt-6-luna',
  'qwen/qwen3-vl-235b-a22b-instruct': 'qwen/qwen3.8-flash',
}

/** The id to use for one that may have been retired — itself, where it has not. */
export const successorOf = (id: string): string => SUCCESSORS[id] ?? id

export const modelById = (id: string | null | undefined): AiModel =>
  AI_MODELS.find((model) => model.id === id) ?? AI_MODELS[0]!

/** Two versions part by part, a missing part counting as nought — positive when `a` is later. */
function compareVersions (a: number[], b: number[]): number {
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0)

    if (difference) return difference
  }

  return 0
}

/** The version a family's id ends in — `[5, 5]` of `anthropic/claude-sonnet-5.5` — or null. */
function versionIn (family: string, id: string): number[] | null {
  if (!id.startsWith(`${family}-`)) return null

  const rest = id.slice(family.length + 1)

  return /^\d+(?:\.\d+)*$/.test(rest) ? rest.split('.').map(Number) : null
}

/**
 * The tracked family a model id belongs to, or null — `anthropic/claude-haiku-4.5`
 * is `anthropic/claude-haiku`. Only families an entry tracks (`family`), so an
 * id this list knows nothing about is never taken for one.
 */
export function familyOf (id: string | null | undefined): string | null {
  if (!id) return null

  return AI_MODELS.find((model) => model.family && versionIn(model.family, id))?.family ?? null
}

/**
 * The newest version of a family among some ids: the highest version, compared
 * part by part (`5.10` is after `5.9`), or null for none. An id with anything
 * after its version — a dated snapshot, a `:beta` — is not a version of the
 * family and is passed over.
 */
export function newestIn (family: string, ids: Iterable<string>): string | null {
  let best: { id: string, version: number[] } | null = null

  for (const id of ids) {
    const version = versionIn(family, id)

    if (version && (!best || compareVersions(version, best.version) > 0)) best = { id, version }
  }

  return best?.id ?? null
}

/**
 * Desktop: whether an id is one of OpenRouter's free models. They come and go
 * by the week, so none is written into the list above; `useModels` offers what
 * the catalogue has, and a reader's choice of one is kept by this test rather
 * than by the list (`remember('kemolate:translate', …)` in `useComic`). Free
 * still needs an OpenRouter key — a free one — and is rate-limited.
 */
export const isFreeModel = (id: string | null | undefined): boolean => Boolean(id?.endsWith(':free'))

/** Desktop: an entry for a free model the catalogue has not answered for yet — see `useModels.byId`. */
export function freeModel (id: string, found?: { name?: string, vision?: boolean, reasoning?: boolean }): AiModel {
  return {
    id,
    label: (found?.name ?? id.replace(/^[^/]+\//, '')).replace(/\s*\(free\)$/i, ''),
    note: 'Free on OpenRouter — slower, and rate-limited',
    free: true,
    vision: found?.vision ?? false,
    reasoning: found?.reasoning ?? false,
    price: { in: 0, out: 0 },
  }
}

/** A tracked entry's label for another version of its family — `Claude Haiku 4.5` as `Claude Haiku 5.5`. */
export function labelFor (model: AiModel, id: string): string {
  const version = model.family ? versionIn(model.family, id) : null

  return version ? model.label.replace(/\d+(?:\.\d+)*$/, version.join('.')) : model.label
}

/**
 * What to call a model, given only the id a row was written with.
 *
 * Not `modelById(...).label`, and the difference matters wherever the id did
 * not come from this list. That function falls back to the *first* curated
 * model, which is right for a picker that must show something selected and
 * quite wrong for a caption: a line translated by an agent over MCP would be
 * labelled with whichever model happens to head the list. The bare id is a
 * worse-looking answer and a true one.
 */
export const modelLabel = (id: string): string =>
  AI_MODELS.find((model) => model.id === id)?.label ?? id

/** Dollars for a page, given what it is expected to spend. */
export function estimateCost (model: AiModel, tokens: { in: number, out: number }): number {
  return (tokens.in * model.price.in + tokens.out * model.price.out) / 1_000_000
}
