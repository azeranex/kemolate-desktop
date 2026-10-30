/**
 * Where a word may break — soft hyphens put in by hand, for the lettering the
 * browser will not hyphenate by itself. Desktop.
 *
 * `hyphens: auto` needs a hyphenation dictionary, and Chromium on Windows
 * downloads its dictionaries through a component updater Electron does not
 * have: three overflowing words in a narrow box stayed three unbroken lines
 * (2026-10-22). So the "hyphenated" rung of every fit was a no-op, and a
 * balloon whose one long word ("NEIGHBORHOOD...") would not go was set smaller
 * instead of broken. A soft hyphen (U+00AD) is honoured with no dictionary at
 * all: the browser breaks there, and draws a hyphen, only where the line needs
 * it. This puts them in from TeX's patterns (`hyphen`, Liang's algorithm) — the
 * probe measures with them (`probeFor`), and the board and the export draw with
 * them, only where a fit asked for hyphens (`LetterFit.hyphens`). Never into
 * the line itself: what is stored, typed and translated is the plain text.
 *
 * Each language's patterns are a chunk of their own, loaded the first time a
 * chapter in that language is fitted (`hyphenationReady`). Until they arrive,
 * `withHyphens` hands the text back as it was, so a fit is never held up
 * waiting — it is measured again when they land. Languages with no patterns
 * here, or that are not broken with hyphens at all (Chinese, Japanese, Korean,
 * Thai, Vietnamese, Arabic, Hindi), are left as they are.
 */

interface Hyphenator {
  hyphenateSync: (text: string, options?: { minWordLength?: number, hyphenChar?: string }) => string
}

/** The patterns for each target language that is broken with hyphens — see `LANGUAGES` in `shared/utils/prompt`. */
const PATTERNS: Record<string, () => Promise<Hyphenator>> = {
  en: () => import('hyphen/en-us'),
  fr: () => import('hyphen/fr'),
  de: () => import('hyphen/de'),
  es: () => import('hyphen/es'),
  it: () => import('hyphen/it'),
  pt: () => import('hyphen/pt'),
  'pt-BR': () => import('hyphen/pt'),
  nl: () => import('hyphen/nl'),
  pl: () => import('hyphen/pl'),
  ru: () => import('hyphen/ru'),
  uk: () => import('hyphen/uk'),
  cs: () => import('hyphen/cs'),
  hu: () => import('hyphen/hu'),
  ro: () => import('hyphen/ro'),
  tr: () => import('hyphen/tr'),
  id: () => import('hyphen/id'),
  ms: () => import('hyphen/id'),
}

/**
 * The shortest word worth breaking. A letterer breaks a long word to save a
 * balloon, never a short one — "ta-ble" in a balloon reads as a mistake.
 */
const MIN_WORD = 7

/** Patterns that have arrived, by language. */
const loaded = new Map<string, Hyphenator>()

/**
 * Languages whose patterns are on their way, with everybody waiting for them,
 * so a page of thirty balloons asks once — and every one of them is told.
 * This was a set of names, and only the first asker's `done` was kept: the
 * board's fit asked, an agent's `review_lettering` asked while the patterns
 * were still in flight, and its promise never settled — the first review of
 * every session timed out after thirty seconds (2026-10-30).
 */
const asked = new Map<string, Array<() => void>>()

/**
 * Languages whose patterns did not load, which are ready from then on without
 * them. Not asked again: each waiter told measures again, and asks — a load
 * retried there fails again and tells it again, for as long as the tab is open.
 */
const failed = new Set<string>()

/** The patterns' language for a target language — its own, or the language without its region. */
const keyOf = (lang: string | undefined) =>
  !lang ? null : PATTERNS[lang] ? lang : PATTERNS[lang.split('-')[0]!] ? lang.split('-')[0]! : null

/**
 * Whether a language's breaks are in hand — asked by the fit, which measures
 * again when they land (`done`). A language that is never hyphenated is ready
 * by definition: there is nothing to wait for.
 */
export function hyphenationReady (lang: string | undefined, done: () => void): boolean {
  const key = keyOf(lang)

  if (!key || loaded.has(key) || failed.has(key)) return true

  const waiting = asked.get(key)

  if (waiting) {
    waiting.push(done)

    return false
  }

  asked.set(key, [done])

  PATTERNS[key]!()
    .then((module) => {
      // A CommonJS module, so its exports may arrive as the module or as its default.
      const found = (module as Hyphenator & { default?: Hyphenator }).default ?? module

      loaded.set(key, found)
    })
    .catch((error: unknown) => {
      failed.add(key)
      console.warn(`[kemolate] hyphenation patterns for ${key} did not load`, error)
    })
    .finally(() => {
      const told = asked.get(key) ?? []

      asked.delete(key)

      for (const call of told) call()
    })

  return false
}

const SHY = '\u00AD'

/**
 * Which breaks `withHyphens` puts in — part of every fit's key (`useLetteringFit`),
 * so a change to where words break measures every hyphenated balloon again rather
 * than drawing new breaks at sizes kept for the old ones. Bump it whenever its
 * output changes. 2: one break to a word (`oneBreak`).
 */
export const HYPHENATION = 2

/**
 * One break to a word, the one nearest its middle. The patterns offer every
 * syllable, and given them the browser broke "NEIGHBORHOOD..." twice in a
 * narrow balloon — "NEIGH- / BOR- / HOOD...", a fragment no letterer would
 * leave on a line of its own. Near the middle, both halves are worth a line.
 */
function oneBreak (word: string): string {
  const at = word.split(SHY)

  if (at.length <= 2) return word

  const plain = at.join('')
  const middle = plain.length / 2
  let cut = 0
  let best = Infinity

  for (let i = 0, offset = 0; i < at.length - 1; i++) {
    offset += at[i]!.length

    if (Math.abs(offset - middle) < best) {
      best = Math.abs(offset - middle)
      cut = offset
    }
  }

  return `${plain.slice(0, cut)}${SHY}${plain.slice(cut)}`
}

/** The text with a soft hyphen where each long word may break, or as it was. */
export function withHyphens (text: string, lang: string | undefined): string {
  const key = keyOf(lang)
  const hyphenator = key ? loaded.get(key) : undefined

  if (!hyphenator) return text

  return hyphenator.hyphenateSync(text, { minWordLength: MIN_WORD }).replace(/\S+/g, oneBreak)
}
