/**
 * How a glossary grows — the rules, without the storage.
 *
 * A cloud workspace's glossary lives on the server (`server/services/glossaries.ts`)
 * and a local workspace's in the browser (`useGlossary`). The two must agree on
 * what a page is allowed to teach, or the same run would build a different list
 * depending on where the chapter is kept — so the rule is written once, here,
 * and both stores ask it.
 *
 * And, since a run began asking about several pages at once, the rule for a page
 * that was asked before the glossary had finished growing — see `askAgain`.
 */
import { castKey } from './cast'

import type { Cast, CastMember, Term } from './prompt'

/**
 * How many terms a chapter may accumulate.
 *
 * The earlier build's forty, and for its reason: this list is prepended to
 * every page of a two-hundred-page run, so each entry is paid for two hundred
 * times. Forty names is more than any one chapter has.
 */
export const MAX_TERMS = 40

/** Long enough for "the Silverleaf Concordat", short enough not to be a line. */
export const MAX_TERM_LENGTH = 80

/** One side of a term, trimmed and bounded. */
export const cleanTerm = (value: unknown) => String(value ?? '').trim().slice(0, MAX_TERM_LENGTH)

/**
 * The terms a page proposed that the glossary should take, in order.
 *
 * **First translation wins**: a source the list already holds is left alone,
 * whatever spelling the page proposes for it. A term that translates to itself
 * teaches nothing and would take a line of every later prompt saying so. The
 * list stops at `MAX_TERMS`.
 */
export function foldTerms (
  current: readonly { source: string }[],
  learned: readonly { src?: unknown, tr?: unknown }[],
): { source: string, target: string }[] {
  const seen = new Set(current.map((term) => term.source))
  const rows: { source: string, target: string }[] = []

  for (const raw of learned) {
    if (current.length + rows.length >= MAX_TERMS) break

    const source = cleanTerm(raw?.src)
    const target = cleanTerm(raw?.tr)

    if (!source || !target || source === target || seen.has(source)) continue

    seen.add(source)
    rows.push({ source, target })
  }

  return rows
}

/** What a page's prompt carried, or what the chapter holds now — the two things `askAgain` compares. */
export interface SettledNames {
  terms: readonly Term[]
  cast: Cast
}

/** What a page's answer said, as far as the rule needs it. */
export interface AnsweredPage {
  /** Every source the model was shown, context lines included. */
  shown: readonly string[]
  /** The lines it answered that are about to be written, with what it said for each. */
  answered: readonly { source: string, text: string }[]
}

/** Case, width and composition are not a difference in a name. */
const folded = (text: string) => text.normalize('NFKC').toLowerCase()

/** Everything the prompt says about one member, in the language being written. */
const said = (member: CastMember, locale: string) =>
  `${member.gender}|${member.names[locale] ?? ''}|${member.tags.join(',')}`

/**
 * Whether a page that was answered without something the chapter has settled
 * since must be asked again — and if so, the name that decided it.
 *
 * ## Why it exists
 *
 * **First translation wins** is a rule about order: the glossary grows a page at
 * a time, and each page is prompted with every term the pages before it
 * settled. A run used to keep that for free by asking one page at a time. It now
 * has three out at once (see `useTranslate`), so page six can be asked before
 * page five has answered — and a name page five settles is then one page six was
 * never told. Writing the pages in order keeps the *list* as a one-at-a-time run
 * would build it; it cannot make page six's lines agree with a term it never
 * saw. This decides when they might not, and the page is then asked again with
 * the glossary as it stands. By then every page before it has been written, so
 * the second prompt carries exactly what a one-at-a-time run would have given
 * it — which is also why a page is asked again at most once.
 *
 * ## The rule
 *
 * - **A term** the page was not told — one the chapter holds now that its
 *   prompt did not carry, or carried rendered differently — sends it back when
 *   the term's source appears in a line the page is about to write and the
 *   answer for that line does not use the settled rendering. Only written lines
 *   count: an answer for a context line is thrown away unread, so a name there
 *   can disagree with nothing.
 * - **A cast member** the page was not told about — new, or since given a
 *   gender, a name in this language or a tag — sends it back whenever they are
 *   named anywhere on the page as it was sent, context included. Gender cannot
 *   be checked in the text the way a spelling can: whether "she" was right is
 *   not something a string search can answer, and a page that names a character
 *   is a page whose pronouns may be about them. This is the cast block's whole
 *   reason to exist (see `whoIsHere`), so it is the one place the rule errs
 *   towards asking.
 * - **Everything else is dropped, not asked about.** A term the page *proposed*
 *   that an earlier page settled differently is refused by `foldTerms` as the
 *   run writes pages in order — the earlier page's rendering stands, as it would
 *   have if the two had been asked in turn — and a proposal that disagrees with
 *   nothing on the page it came from changes nothing about that page's words.
 *
 * What it cannot see, said plainly: a character who speaks on a page without
 * being named there. A one-at-a-time run would have shown that page the cast,
 * and the artwork might have told the model who was talking; a page asked in
 * parallel with the one that introduced them was not shown it, and nothing in
 * its text says it should have been.
 *
 * Pure, so the decision to spend a second request is testable without one.
 */
export function askAgain (asked: SettledNames, now: SettledNames, page: AnsweredPage, locale: string): string | null {
  const knew = new Map(asked.terms.map((term) => [term.source, term.target]))

  for (const term of now.terms) {
    if (knew.get(term.source) === term.target) continue

    const source = folded(term.source)
    const rendering = folded(term.target)

    if (!source || !rendering) continue

    const disagrees = page.answered.some((line) =>
      folded(line.source).includes(source) && !folded(line.text).includes(rendering))

    if (disagrees) return term.source
  }

  const before = new Map(asked.cast.members.map((member) => [castKey(member.source), said(member, locale)]))
  const shown = page.shown.map(folded)

  for (const member of now.cast.members) {
    if (before.get(castKey(member.source)) === said(member, locale)) continue

    const names = [member.source, ...Object.values(member.names)].map(folded).filter(Boolean)

    if (names.some((name) => shown.some((line) => line.includes(name)))) return member.source
  }

  return null
}
