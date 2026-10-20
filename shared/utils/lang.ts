/**
 * Which blocks on a page are already in the language being translated *to*.
 *
 * Ported from the earlier build, where it paid for itself immediately. A comic
 * carries writing that is not its dialogue: a logo on a shirt, a rating stamp,
 * a signature, a page number. Sending those to a model costs a call to be told
 * what they already say — and a model asked to translate "ECLIPSE" into English
 * will sometimes oblige with something else.
 *
 * The test is **script**, not language, because script is the one thing a page
 * can be judged on without asking anybody. But script alone would be a trap:
 * English into French is Latin either way, and skipping on "already Latin"
 * would leave such a page untranslated. So a block is judged against *the page
 * it is on* — it is left alone only when it reads in a different script from
 * the rest of the page and that script is the target's. On a page whose writing
 * is all one script there is nothing to tell apart, and everything goes.
 *
 * Shared rather than kept beside the translator, because the panel counts what
 * a press would cost before anything is pressed, and a count that disagreed
 * with the run would be worse than no count.
 */

/** The writing systems worth telling apart here. */
export type Script = 'latin' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'thai' | 'devanagari'

/**
 * Unicode's own answer, rather than the hand-written code-point ranges this
 * replaced. Those ranges were right about the scripts they named and quietly
 * wrong at the edges — `[A-Za-zÀ-ɏ]` is Latin up to Extended-B and then stops,
 * so a Vietnamese line full of Latin Extended Additional read as no script at
 * all and was skipped as punctuation.
 *
 * Kana is asked about before Han because Japanese mixes them and the kana is
 * what identifies it; the order matters to nothing else here, since `scriptsIn`
 * collects all of them.
 */
const RANGES: [Script, RegExp][] = [
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['latin', /\p{Script=Latin}/u],
]

/** Every script a piece of writing uses, in no particular order. */
export function scriptsIn (text: string): Set<Script> {
  const found = new Set<Script>()

  for (const [script, pattern] of RANGES) if (pattern.test(text)) found.add(script)

  return found
}

/**
 * The one script a piece of writing is in, or null when it is in none or in
 * several. Japanese is the exception worth naming: kana beside Han is still one
 * language, and the kana settles it.
 */
export function scriptOf (text: string): Script | null {
  const found = scriptsIn(text)

  if (!found.size) return null
  if (found.size === 1) return [...found][0]!
  if (found.size === 2 && found.has('kana') && found.has('han')) return 'kana'

  return null
}

/**
 * What a target language is written in.
 *
 * Every code the picker offers has an answer here — see `LANGUAGES` — and the
 * default is Latin, which covers the two thirds of the list that are Latin and
 * is the safe answer for a code arriving from somewhere other than the picker:
 * a wrong "latin" makes a block go to the model that need not have, where a
 * wrong anything-else makes a block that needed translating be skipped.
 */
export function scriptForLang (locale: string): Script {
  switch (locale.toLowerCase().split('-')[0]) {
    case 'ru': case 'uk': case 'bg': case 'sr': case 'be': case 'mk': return 'cyrillic'
    case 'zh': return 'han'
    case 'ja': return 'kana'
    case 'ko': return 'hangul'
    case 'ar': case 'fa': case 'ur': return 'arabic'
    case 'th': return 'thai'
    case 'hi': case 'mr': case 'ne': return 'devanagari'
    default: return 'latin'
  }
}

/**
 * What the page as a whole is written in, by which script the most blocks use.
 * Blocks in no script at all — bare punctuation, a lone number — carry no vote.
 */
export function pageScript (texts: string[]): Script | null {
  const votes = new Map<Script, number>()

  for (const text of texts) {
    const script = scriptOf(text)

    if (script) votes.set(script, (votes.get(script) ?? 0) + 1)
  }

  let best: Script | null = null
  let top = 0

  for (const [script, count] of votes) if (count > top) { best = script; top = count }

  return best
}

/**
 * Whether this block still has to be sent anywhere.
 *
 * No: writing with no letters in it at all — "!?", "……", "123" — which comes
 * back as itself whatever is asked of it. No: a block in the target's own
 * script on a page written in another, which is the shirt logo on a Japanese
 * page being read into English. Yes: everything else, including every block on
 * a page that is all one script, where there is nothing to tell apart.
 */
export function needsTranslation (text: string, locale: string, page: Script | null): boolean {
  const trimmed = text.trim()

  if (!trimmed) return false

  const own = scriptOf(trimmed)

  // Nothing word-forming: punctuation, digits, a stray symbol.
  if (!own && !scriptsIn(trimmed).size) return false

  // More than one script in one block — let the model read it.
  if (!own) return true

  if (!page) return true

  // The same script as the rest of the page: this is the page's own language,
  // whatever that is, so it needs translating even into a same-script target.
  if (own === page) return true

  return own !== scriptForLang(locale)
}
