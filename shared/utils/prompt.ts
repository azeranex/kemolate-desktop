/**
 * What the model is asked, for one page.
 *
 * Ported from the earlier build's `pagePrompt`, and kept apart from the thing
 * that sends it for the same reason it was there: what goes into the prompt is
 * the whole of what makes a translation good or wrong, and if it can only be
 * read by spending a request then nobody reads it. Here it is a pure function
 * of its inputs, so it can be printed, diffed and tested for nothing.
 *
 * Every paragraph below was paid for once already. The glossary block is what
 * keeps a name spelled the same in chapter nine as in chapter one. The cast
 * block exists because a source that drops its pronouns leaves gender to be
 * worked out from the line, and worked out afresh each page it comes out
 * differently each page — which is how a character changes sex between
 * chapters. And `only` still sends the whole page, because a comic's lines lean
 * on each other: `怎...` alone reads as a standalone "what?", but beside the
 * `怎麼可以......` it breaks off from it is the "H—" of "How could I...".
 */

/**
 * Language names, so the prompt asks for a language rather than a code.
 *
 * The one list, and the picker in the interface is drawn from it — see
 * `useTargetLanguage`. Two lists is what this replaced, and they had already
 * come apart: the picker offered twenty-six languages, this knew fourteen, and
 * `nameOf` falls back to the code it was given. So choosing Brazilian
 * Portuguese sent a model the instruction to translate into "pt-BR", and the
 * only sign of it was in the answer.
 *
 * That fallback is kept, because it is right for a code that arrives from
 * somewhere other than the picker. It just must not be how the ordinary case
 * works.
 *
 * Ordered by name rather than by code, because the picker takes its order from
 * here and a reader looking for Spanish is looking under S. The names are
 * written for both jobs at once: a heading in a list, and the end of the
 * sentence "translate into ___", which is why the ambiguous ones say which they
 * are in words a model reads as readily as a person.
 */
export const LANGUAGES: Record<string, string> = {
  ar: 'Arabic',
  zh: 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  cs: 'Czech',
  nl: 'Dutch',
  en: 'English',
  fil: 'Filipino',
  fr: 'French',
  de: 'German',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  ms: 'Malay',
  pl: 'Polish',
  'pt-BR': 'Portuguese (Brazil)',
  pt: 'Portuguese (Portugal)',
  ro: 'Romanian',
  ru: 'Russian',
  es: 'Spanish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
}

/**
 * The same list as the interface wants it: a code and a label, in order.
 *
 * A record keeps the order it was written in, so this needs no sorting of its
 * own — and the day the list is sorted differently, both the prompt and the
 * picker move together, which is the whole point of there being one of it.
 */
export const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).map(([value, label]) => ({ value, label }))

export const nameOf = (locale: string) => LANGUAGES[locale] ?? locale

/** Whether a code is one this app actually offers. */
export const isLanguage = (locale: string) => locale in LANGUAGES

/**
 * How hard a model is asked to think before answering — the provider's own
 * vocabulary, not the interface's.
 *
 * `useComic` has its own `Effort` of fast/balanced/thorough, which is the thing
 * a translator picks. This is what that gets turned into on the way out, and
 * keeping the two named apart stops one silently standing in for the other.
 *
 * `'none'` is OpenRouter's way of switching thinking **off**, and it is not the
 * same as `'minimal'` — which is what this list used to bottom out at, and the
 * reason a "Fast" pass against a reasoning model still thought. On DeepSeek V4
 * that was most of the bill rather than a rounding error: hidden reasoning is
 * billed at the output rate, and a page came back with 402 output tokens of
 * which 240 were thinking.
 *
 * It is also not `exclude`, which is the trap next to it in the same parameter.
 * `exclude: true` hides the reasoning from the reply and *still charges for it*
 * — useful for keeping a response tidy, useless for keeping it cheap.
 */
export const REASONING_EFFORTS = ['auto', 'none', 'high', 'medium', 'low', 'minimal'] as const

export type ReasoningEffort = typeof REASONING_EFFORTS[number]

/**
 * What the interface's three settings ask a model for.
 *
 * Fast means *no thinking at all*, which is what its own description in the
 * panel has always claimed — "one pass" is a promise about the number of
 * passes, and `minimal` quietly took two. A model that refuses `'none'` falls
 * back to its own default rather than failing the page; see `translatePage`,
 * which retries any 400 that mentions reasoning.
 */
export const REASONING_FOR: Record<'fast' | 'balanced' | 'thorough', ReasoningEffort> = {
  fast: 'none',
  balanced: 'medium',
  thorough: 'high',
}

/** One term this comic has already settled on. */
export interface Term {
  source: string
  target: string
}

/**
 * What a character is, for the purpose of writing their lines.
 *
 * Held as a fact about the person rather than as a phrase, because every
 * language spells the consequence differently: English picks a pronoun, Spanish
 * agrees its adjectives, Indonesian does neither. `unknown` is a real answer and
 * the safe one — it tells the model to write around the question instead of
 * settling it.
 *
 * Nothing stores these yet. The prompt takes them because the prompt is where
 * they earn their keep, and wiring a table to it later should not mean
 * rewriting this.
 */
export interface CastMember {
  /** The name as the source writes it. */
  source: string
  /** How it reads in each target language, keyed by locale. */
  names: Record<string, string>
  gender: 'male' | 'female' | 'nb' | 'unknown'
  /** Short descriptors — role, register, who they are to the others. */
  tags: string[]
}

export interface Cast {
  members: CastMember[]
  /** A standing instruction about the work as a whole. */
  notes: string
}

export const NO_CAST: Cast = { members: [], notes: '' }

const GENDER: Record<CastMember['gender'], string> = {
  male: 'male',
  female: 'female',
  nb: 'non-binary',
  unknown: 'gender unestablished',
}

export interface PromptInput {
  /** The source text of each block, in reading order. */
  blocks: string[]
  /** Locale to translate into. */
  target: string
  glossary?: Term[]
  cast?: Cast
  /** Whether the page image travels with the prompt. */
  hasImage?: boolean
  /** Translate only this block, with the rest as context. */
  only?: number
  /**
   * Whether -san, -kun, -senpai and the rest survive the move.
   *
   * A real fork in how a comic reads rather than a nicety, which is why it is
   * asked of the reader and said here in words: one house keeps them because
   * the relationships between characters are half the story, another strips
   * them because a line that says "Tanaka-san" in English reads as untranslated.
   * Neither is the right default for everybody, so neither is assumed — a model
   * left to choose picks differently from page to page, and the inconsistency
   * is worse than either answer.
   */
  honorifics?: boolean
}

/**
 * What the chapter has already settled on, and what it knows about the people
 * in it — the three standing blocks, and the two paragraphs that ask for more.
 *
 * Lifted out of `pagePrompt` when the region brush grew an ask of its own. They
 * are not decoration: the glossary block is what keeps a name spelled the same
 * in chapter nine as in chapter one, and the cast block is what stops a
 * character changing sex halfway down a volume. A region translated without
 * them is a line that disagrees with the page it sits on — which is exactly the
 * failure the loop exists to prevent, arriving by a new door.
 *
 * So they are shared rather than copied. Two wordings of "reuse these exactly"
 * is two behaviours, and the one nobody is reading is the one that drifts.
 */
function settled (glossary: Term[]): string {
  // Earlier pages settled on these; reusing them is what keeps a name the same
  // name across a volume.
  return glossary.length
    ? `\n\nThis comic has already used these translations. Reuse them exactly:\n${
      glossary.map((term) => `  ${term.source} → ${term.target}`).join('\n')}\n`
    : ''
}

function whoIsHere (cast: Cast, target: string): string {
  const language = nameOf(target)

  return cast.members.length
    ? `\n\nCAST OF THIS COMIC — these are established facts, not suggestions:\n${
      cast.members.map((member) => {
        const name = member.names[target]
        const to = name && name !== member.source ? ` → ${name}` : ''
        const tags = member.tags.length ? `; ${member.tags.join(', ')}` : ''

        return `  ${member.source}${to} (${GENDER[member.gender]}${tags})`
      }).join('\n')
    }
Name every one of these characters as listed, whatever spelling the page uses for them. Take each one's gender from this list and from nothing else — pronouns, and every word of ${language} that agrees with them, follow it. For a character listed as gender unestablished, and for any speaker not on this list, write the line without committing to a gender rather than choosing one.\n`
    : ''
}

function standingNote (cast: Cast): string {
  return cast.notes.trim()
    ? `\n\nAbout this comic, from its translator — this outranks your own reading of the page:\n${cast.notes.trim()}\n`
    : ''
}

// Said as an instruction about names rather than about suffixes, because the
// question is wider than the suffix: "senpai" and "onii-chan" are the same
// decision as "-san", and a rule written about hyphens would keep one and
// localise the other on the same page.
function onHonorifics (honorifics: boolean): string {
  return honorifics
    ? 'Keep honorifics and forms of address exactly as the source writes them — -san, -kun, -chan, -senpai, sunbae, oppa and the rest — rather than replacing them with a target-language equivalent or dropping them.'
    : 'Drop honorifics and untranslated forms of address; address each character as the target language naturally would, and carry the respect or familiarity they marked in the wording of the line instead.'
}

/** The two fields every ask collects for the loop, as JSON. */
const LEARNED = (language: string) =>
  `"glossary": [{"src": "<original>", "tr": "<your translation>"}], "cast": [{"name": "<name as the source writes it>", "tr": "<the name in ${language}>", "gender": "male|female|nb|unknown", "tags": ["<short descriptor>"]}]`

/** And what each of them is for, said to the model rather than assumed. */
const LEARNING = `In "glossary", list only recurring series-specific terms worth keeping identical on later pages — character names, place names, the name of a product or service, distinctive catchphrases. Skip ordinary words and anything already listed above. Use [] if there are none.

In "cast", list characters this page named or spoke as, and skip anyone already in the cast above. Give the gender only where the page itself establishes it — a pronoun used of them, how they are addressed, how the artwork draws them — and "unknown" otherwise. Guessing here is worse than leaving it open: an entry lands in the appendix and speaks for every later page. Keep "tags" to a few words apiece — their role, their register, who they are to the others. Use [] if the page introduced nobody.`

/*
 * The pieces a page prompt is built from.
 *
 * Named, rather than written inline in `pagePrompt` as they were, because there
 * are now two arrangements of the same sentences: the page prompt the browser
 * sends, whole, and the batch an agent is handed over MCP, where everything a
 * page does not own is said once for twenty pages (`standingPrompt` and
 * `batchPagePrompt`). Two copies of "keep sound effects short and punchy" would
 * be the two wordings `settled` exists to prevent, and the one nobody is reading
 * would be the one that drifts — so each sentence is written here once and both
 * arrangements are assembled out of it.
 *
 * `pagePrompt` is assembled exactly as it was before the split, character for
 * character: what the browser asks a model did not change.
 */

/** The sentence that introduces a page's lines — the one place the count is said up front. */
function introOf (count: number, hasImage: boolean): string {
  return hasImage
    ? `The attached image is a comic page. Below are its ${count} OCR-extracted text blocks, numbered in reading order:`
    : `Below are the ${count} OCR-extracted text blocks of one comic page, numbered in reading order. They are a mix of speech-bubble dialogue and sound effects:`
}

/** A page's lines, numbered from one, which is the numbering every answer is read back through. */
const numberedOf = (blocks: string[]) => blocks.map((text, i) => `${i + 1}. ${text}`).join('\n')

function guidanceOf (hasImage: boolean): string {
  return hasImage
    ? 'Use the artwork for context — who is speaking, their tone, and what is happening — so the dialogue reads like a professionally localized comic.'
    : 'Translate so the page reads like a professionally localized comic — natural, colloquial dialogue, consistent voice across bubbles.'
}

/** The line a single-line ask is about, or null for the whole page — an index off the page is the whole page. */
const oneOf = (only: number | undefined, count: number) =>
  only !== undefined && only >= 0 && only < count ? only : null

function taskOf (one: number | null, language: string): string {
  return one === null
    ? `Translate each block into ${language}.`
    : `Translate ONLY block ${one + 1} into ${language}. The other blocks are context — who is speaking, what was just said, and how the line carries on. A block that breaks off part-way is usually the opening of the one that follows it, and should be rendered as those same words breaking off at the same point, not as a phrase of its own.`
}

/** What every ask asks of the lettering itself, whatever the page. */
const CRAFT = 'Keep sound effects short and punchy. Silently fix obvious OCR errors before translating. Auto-detect the source language.'

const RESPOND = 'Respond with ONLY a JSON object — no markdown fences, no commentary — of this exact shape:'

function shapeOf (one: number | null, extras: string): string {
  return one === null
    ? `{"source_language": "<ISO 639-1 code>", "translations": ["<block 1>", "<block 2>", ...], ${extras}}`
    : `{"source_language": "<ISO 639-1 code>", "translations": ["<block ${one + 1}>"], ${extras}}`
}

/** How many translations are wanted back — the sentence that finishes the shape. */
function countOf (one: number | null, count: number): string {
  return one === null
    ? `with exactly ${count} translations, one per block, in the same order.`
    : `with exactly one translation — block ${one + 1}, and nothing for the others.`
}

export function pagePrompt ({
  blocks,
  target,
  glossary = [],
  cast = NO_CAST,
  hasImage = false,
  only,
  honorifics = true,
}: PromptInput): string {
  const language = nameOf(target)
  const one = oneOf(only, blocks.length)

  return `${introOf(blocks.length, hasImage)}

${numberedOf(blocks)}
${settled(glossary)}${whoIsHere(cast, target)}${standingNote(cast)}
${taskOf(one, language)} ${guidanceOf(hasImage)} ${onHonorifics(honorifics)} ${CRAFT}

${RESPOND}
${shapeOf(one, LEARNED(language))}
${countOf(one, blocks.length)}

${LEARNING}`
}

/** What every page of a batch shares — `PromptInput` without the page. */
export type StandingInput = Omit<PromptInput, 'blocks' | 'only'>

/**
 * The part of a page prompt that is the same for every page of a batch, said
 * once — for an agent answering twenty pages in one go over MCP.
 *
 * A page prompt is mostly not about the page. The instructions, the reply's
 * shape, the two paragraphs asking what the page taught, and — the part that
 * grows — the chapter's glossary and cast are identical on every page of a run,
 * and `prepare_page_translation` used to hand them over once per page: a real
 * twenty-page batch with a sixteen-term glossary and six cast members was
 * about 25k tokens, and is about 9k said this way. The agent reading it is one
 * model reading one reply, so saying the standing part once loses nothing, and
 * the pages then cost what their lines cost. See `batchPagePrompt` for the half
 * that is each page's own.
 *
 * Every sentence is the page prompt's own (see the pieces above); only the
 * order differs, standing part first, because it is now read before twenty
 * pages rather than after one. The browser does not use this: it sends one page
 * per request, and a request has no batch to share with.
 */
export function standingPrompt ({
  target,
  glossary = [],
  cast = NO_CAST,
  hasImage = false,
  honorifics = true,
}: StandingInput): string {
  const language = nameOf(target)

  return `These instructions are for every page that follows. Each page comes with its own prompt: its OCR-extracted text blocks, numbered in reading order, and how many translations it wants back.
${settled(glossary)}${whoIsHere(cast, target)}${standingNote(cast)}
Translate each page's blocks into ${language}. ${guidanceOf(hasImage)} ${onHonorifics(honorifics)} ${CRAFT}

Answer each page on its own. ${RESPOND}
${shapeOf(null, LEARNED(language))}
with as many translations as that page's prompt asks for, in the same order.

${LEARNING}`
}

/**
 * One page of a batch: its lines and its count, and nothing `standingPrompt`
 * has already said.
 *
 * The single-line ask keeps its whole paragraph here rather than moving to the
 * standing part, because it is a fact about *this* page — which of its lines is
 * wanted and that the rest are context — and a model told it once for the batch
 * would apply it to the wrong pages.
 */
export function batchPagePrompt ({
  blocks,
  target,
  hasImage = false,
  only,
}: Pick<PromptInput, 'blocks' | 'target' | 'hasImage' | 'only'>): string {
  const one = oneOf(only, blocks.length)

  return `${introOf(blocks.length, hasImage)}

${numberedOf(blocks)}

${taskOf(one, nameOf(target))} Answer ${countOf(one, blocks.length)}`
}

export interface RegionPromptInput {
  /** Locale to translate into. */
  target: string
  glossary?: Term[]
  cast?: Cast
  honorifics?: boolean
  /** Which way the chapter's columns run. */
  direction?: 'ltr' | 'rtl'
}

/**
 * One region of a page: read it, and carry it over — in a single ask.
 *
 * The Translate region brush. Somebody paints over lettering the detector never
 * found, and what comes back is both what is printed there and what it should
 * say instead. Two answers from one request, and that is the whole design rather
 * than an economy: the model reading the picture and the model writing the line
 * are the same model looking at the same balloon, so splitting it into a
 * transcribe call and a translate call pays twice to show it the same crop and
 * gives the second half less to go on than the first had.
 *
 * ## Both halves are asked for, and the reading is asked for first
 *
 * `"source"` is not a courtesy. It is what the page is understood to *say* —
 * checked against the picture beside it, corrected by hand, re-read, and fed to
 * every later ask about this block. A model that answered only with the
 * translation would leave the block claiming an empty source, which reads
 * downstream as "nothing was found here".
 *
 * Asked in that order because it is the order the work happens in: a model that
 * writes the English first and the Japanese afterwards is reconstructing what it
 * must have read, and reconstructions agree with the translation rather than
 * with the page.
 *
 * ## Why this is asked of a crop and never of a page
 *
 * A model handed a whole page and asked where the lettering is estimates boxes
 * that trace the *columns* of source text, so the English lettered back into one
 * runs down a five-character strip. That is written down at greater length in
 * `CLAUDE.md` under the MCP reading loop, where it cost a rewrite to learn. The
 * region brush sidesteps it completely by never asking the question: the crop is
 * the region, somebody painted it, and all that is wanted back is the words. So
 * there is no box in the shape below and no way to ask for one.
 *
 * ## The instructions that are this prompt's own
 *
 * - **Transcribe exactly, and do not tidy.** `pagePrompt` says the opposite
 *   ("silently fix obvious OCR errors") and is right to: it is reading a
 *   machine's output. Here the model *is* the machine, and a source corrected on
 *   the way out is a source that cannot be checked against the page.
 * - **The order of the columns**, which is the one thing about the crop it
 *   genuinely cannot know. A vertical balloon is a set of columns and the
 *   chapter says which end they start at; a model left to guess reverses roughly
 *   half of them, and a reversed balloon reads as a plausible sentence rather
 *   than as an error.
 * - **White is not paper.** The crop is masked to white outside what was painted
 *   — see `knockOut` — so a model that reads the flat areas as blank page
 *   furniture and describes them is answering about the mask.
 *
 * Two empty strings for nothing readable are stated as a real answer, because
 * the alternative a model reaches for is a sentence of apology, and a sentence
 * of apology in `source` is indistinguishable from lettering that says so.
 *
 * The glossary and the cast travel with it like any other ask — see `settled`
 * and `whoIsHere`. A region is a line of the same chapter, and one translated
 * without them is one that calls a character by a name the rest of the volume
 * does not use.
 */
export function regionPrompt ({
  target,
  glossary = [],
  cast = NO_CAST,
  honorifics = true,
  direction = 'rtl',
}: RegionPromptInput): string {
  const language = nameOf(target)

  const columns = direction === 'rtl'
    ? 'right to left, the way Japanese and Chinese comics set them'
    : 'left to right'

  return `The attached image is one region cut out of a comic page — a piece of lettering somebody has pointed at. Read it, then translate it into ${language}.

First, transcribe the lettering exactly as printed, in its original language. Do not correct, tidy or complete it, and do not romanise it or write it in any script other than the one on the page. Reproduce the characters that are there, including any cut off at the edge: this transcription is checked against the picture, so a helpful correction is a silent error.

Where the region holds more than one line or column, put each on its own line in the transcription. Vertical columns are read top to bottom, and the columns themselves run ${columns}.

Ignore the artwork. The flat white areas are a mask covering the rest of the page rather than part of the picture, so read only what is inside the unmasked region and never describe what you see.
${settled(glossary)}${whoIsHere(cast, target)}${standingNote(cast)}
Then translate what you read into ${language}, so it reads like a professionally localized comic — natural, colloquial, in the voice the artwork and the lettering suggest. ${onHonorifics(honorifics)} Keep sound effects short and punchy. Auto-detect the source language.

${RESPOND}
{"source_language": "<ISO 639-1 code>", "source": "<the lettering, exactly as printed>", "translation": "<it, in ${language}>", ${LEARNED(language)}}

If there is no readable lettering in the region, answer with "source" and "translation" both set to "". Two empty strings are a real answer and the right one; do not explain, apologise or guess.

${LEARNING}`
}

export interface ShortenPromptInput {
  /** What the balloon says in the original, so the meaning is taken from the page rather than from a draft of it. */
  source: string
  /** The line as it stands, which is too long. */
  translation: string
  /** The most characters the balloon holds at the chapter's standard size. */
  budget: number
  /** Locale the line is written in. */
  target: string
  glossary?: Term[]
  cast?: Cast
  honorifics?: boolean
  /**
   * The page's lines as translated so far, in reading order, with the one being
   * shortened among them at `at`. Optional, and only context — see
   * `shortenPrompt`.
   */
  page?: string[]
  at?: number
}

/**
 * How a shortening treats forms of address — a narrower sentence than
 * `onHonorifics`, on purpose.
 *
 * That one tells a model which way to *translate*. This one is said to a model
 * holding a line that has already been translated under the chapter's rule, and
 * the risk is the opposite: that a "-san" or an "onii-chan" looks like the
 * cheapest few characters on the line to cut. Kept, it is not padding; dropped,
 * it is the chapter's honorifics setting quietly reversed by the letterer's
 * button. And where the chapter drops them, a rewording must not bring one back.
 */
function keepAddress (honorifics: boolean): string {
  return honorifics
    ? 'Keep every honorific and form of address the current wording has — -san, -kun, -chan, -senpai, onii-chan and the rest. They are part of the relationship, not spare characters to cut.'
    : 'Do not introduce honorifics or untranslated forms of address.'
}

/** The page around the line, with the line itself marked — or nothing where no page was given. */
function aroundOf (page: string[] | undefined, at: number | undefined): string {
  if (!page?.length || at === undefined || at < 0 || at >= page.length) return ''

  const lines = page.map((text, i) => `${i === at ? '→' : ' '} ${text.trim() || '(not translated yet)'}`)

  return `\nThe page it sits on, as translated so far — for voice and continuity only; the marked line is the one to shorten, and the others stay as they are:\n${lines.join('\n')}\n`
}

/**
 * One translated line, asked for again in fewer characters — the letterer's
 * "send it back" when a line does not fit its balloon.
 *
 * A professional letterer who cannot fit a line does not shrink the type
 * below the chapter's size; they return the line for a shorter wording. The
 * lettering side works out how many characters the frame holds (`budget`) and
 * this is what the model is then asked. A pure function like `pagePrompt`, for
 * the same reason: it can be printed and tested without spending a request.
 *
 * ## What travels, and what does not
 *
 * - **The source as well as the draft.** Shortening from the translation alone
 *   is rewording a rewording, and each pass drifts a little further from what
 *   the balloon says. With the original in view the model cuts towards the
 *   meaning rather than towards the nearest shorter English.
 * - **The glossary and the cast, whole.** They are not optional extras here any
 *   more than on a page: a shortening is exactly where "Lady Yamada" becomes
 *   "Yamada" and a name stops matching chapter one, and where a rewording that
 *   drops a pronoun picks a different one back up. `settled` and `whoIsHere`
 *   are the page prompt's own sentences, so the two cannot disagree.
 * - **The page, when given**, as translated lines with this one marked — which
 *   is what keeps a line that breaks off (`怎...` → "H—") breaking off rather
 *   than being "shortened" into a sentence of its own. Its translations rather
 *   than its sources, because what is being matched is the voice the page
 *   already has in the target language.
 * - **No image**, whichever engine is chosen. The question is how many letters,
 *   and the picture costs more than everything else here put together to
 *   answer something the draft already settled.
 *
 * ## The reply is the line and nothing else
 *
 * Not JSON, unlike every other ask: there is one string to return and nothing
 * to learn — a shortening introduces no names, and asking for a glossary on
 * the side is how a model starts rephrasing names to have something to report.
 * `shortLineFrom` reads the reply, and forgives the quotes a model wraps a line
 * in despite being told not to.
 *
 * "At most" rather than "about", and a stated fallback for a line that cannot
 * get there honestly: the tightest faithful version, never a line that says
 * less. A model given no way out will meet the number by cutting meaning, and
 * a balloon a size too full is a smaller problem than one that says the wrong
 * thing.
 */
export function shortenPrompt ({
  source,
  translation,
  budget,
  target,
  glossary = [],
  cast = NO_CAST,
  honorifics = true,
  page,
  at,
}: ShortenPromptInput): string {
  const language = nameOf(target)
  const most = Math.max(1, Math.floor(budget))
  const chars = `${most} character${most === 1 ? '' : 's'}`

  return `This is one line of comic lettering, already translated into ${language}. It has to fit inside its speech balloon, and as written it does not. Write a shorter version of it.

Original: ${source.trim()}
Current ${language}: ${translation.trim()}
${aroundOf(page, at)}${settled(glossary)}${whoIsHere(cast, target)}${standingNote(cast)}
Write the line in ${language} in at most ${chars}, counting spaces and punctuation. Keep what it means, and keep the speaker's voice and register — cut words, not character. Spell every name and term exactly as listed above. ${keepAddress(honorifics)} Write it as a single line; the letterer will break it.

If it cannot be brought within ${chars} without losing what it means, give the shortest version that still says all of it. If it already fits, give the tightest faithful version.

Respond with ONLY the new line — no quotation marks, no notes, no character count.`
}

/**
 * Quotation pairs a model puts around a line it was told to return bare. The
 * corner brackets are there because a line going into Japanese or Chinese gets
 * wrapped in them exactly as an English one gets wrapped in straight quotes.
 */
const WRAPPERS: [string, string][] = [
  ['"', '"'],
  ['\'', '\''],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ['「', '」'],
  ['『', '』'],
]

/**
 * A shortening reply, as the line it is — or an empty string where it is not
 * one.
 *
 * Trimmed, and a single line: a line lettered into a balloon is broken by the
 * letterer, and a stray newline in the middle of it would be taken for a break
 * somebody chose. One pair of wrapping quotes is taken off — but only where the
 * line it replaces was not itself wrapped the same way, since then the quotes
 * are the lettering (a sign, a quoted remark) and belong to the answer; and
 * only where the closing mark does not also appear inside, which is two quoted
 * phrases side by side rather than one line in quotes.
 */
export function shortLineFrom (reply: string, was = ''): string {
  const line = reply.trim().replace(/\s*\n\s*/g, ' ')
  const before = was.trim()

  for (const [open, close] of WRAPPERS) {
    const wrapped = (text: string) => text.length >= 2 && text.startsWith(open) && text.endsWith(close)

    if (!wrapped(line) || wrapped(before)) continue

    const inner = line.slice(open.length, -close.length)

    if (!inner.includes(close)) return inner.trim()
  }

  return line
}

/**
 * The outermost JSON object in a model's reply.
 *
 * Models wrap it in fences or a sentence of preamble despite being told not to,
 * and every provider does it, so the salvage lives in one place.
 */
export function jsonFrom (text: string): unknown {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')

  if (open === -1 || close <= open) {
    throw new Error('The model returned something that was not JSON — try again.')
  }

  return JSON.parse(text.slice(open, close + 1)) as unknown
}
