/**
 * Roughly how many tokens a piece of text comes to, without a tokeniser.
 *
 * A real tokeniser is per-model, ships as a megabyte of vocabulary, and would
 * have to be downloaded before a panel could print a number — for an estimate
 * that is shown beside the word "estimate". So this counts characters and
 * weights them by script, which is the part that actually matters.
 *
 * **The one thing a flat characters-per-token ratio gets badly wrong is CJK.**
 * The familiar "about four characters to a token" is an English rule: byte-pair
 * vocabularies are built mostly on Latin text, so a Japanese or Chinese page
 * comes out at roughly *one token per character* — four times what the rule
 * predicts, on exactly the pages this app exists for. A single ratio therefore
 * cannot be both right for the source and right for the English instructions
 * wrapped around it, and a page prompt is always both at once.
 *
 * The weights are approximations of a spread, not constants anybody promised:
 * kanji run above one token apiece and kana a little below, Cyrillic and Thai
 * land between the two, and Latin sits near a quarter. They are good to within
 * a fifth or so, which is the right accuracy for a figure whose job is to tell
 * you whether a chapter costs ten cents or ten dollars.
 */

/** Han, kana and hangul: about a token each, sometimes more. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Scripts the vocabularies know less well than Latin and better than CJK. */
const MEDIUM = /[\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}]/gu

const DENSE_RATE = 1.1
const MEDIUM_RATE = 0.5

/** The English rule of thumb, which is right for the two thirds of a prompt that is English. */
const LATIN_RATE = 0.25

export function estimateTokens (text: string): number {
  if (!text) return 0

  const dense = text.match(DENSE)?.length ?? 0
  const medium = text.match(MEDIUM)?.length ?? 0
  const rest = text.length - dense - medium

  return Math.round(dense * DENSE_RATE + medium * MEDIUM_RATE + rest * LATIN_RATE)
}

/**
 * What sending a page costs before a word of it is read.
 *
 * Image tokens go by area rather than by file size — a provider re-encodes the
 * picture into tiles regardless of how well it was compressed — and the divisor
 * is the one the earlier build measured against and sized `IMAGE_MAX_EDGE` to
 * hit. A page is shrunk to fit inside that square before it is sent (see
 * `shrinkForModel`), so this measures the copy that actually travels, not the
 * four-thousand-pixel scan on disk.
 *
 * Falls back to the square at full size when the scan has not said how big it
 * is yet, which errs high — the right direction for a number somebody is about
 * to spend money against.
 */
export function imageTokens (width: number, height: number, maxEdge: number): number {
  const longest = Math.max(width, height)
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1

  const w = width > 0 ? width * scale : maxEdge
  const h = height > 0 ? height * scale : maxEdge

  return Math.round((w * h) / 750)
}
