/**
 * Where a balloon's lines break, judged from the lines as drawn — desktop, for
 * `review_lettering`.
 *
 * A letterer breaks a balloon one phrase to a line, short at the top, widest in
 * the middle, short again at the foot. The wrap only asks how many words fit, so
 * at a smaller size it packs a line mid-phrase and leaves what is over on a line
 * of its own: "FIRST, LET / ME SHOW / YOU / AROUND THE", "HM? OH, / YEAH, IT /
 * IS." (2026-10-23). Those two shapes are what is flagged here, from the words
 * alone, so an agent sees them without a picture. A phrase split across lines
 * ("LET / ME") is not: telling one needs the language, and the agent reading the
 * reported lines has it.
 *
 * Lengths are characters — rough against a proportional face, and plenty for a
 * line that is a third of the ones round it.
 */

export type BreakFlag = 'stranded-word' | 'lone-last-word' | 'rewrapped'

/** A middle line of one word under this share of both its neighbours is stranded. */
const STRANDED = 0.6

/** A last line of one word under this share of the line above is left alone. */
const LONE = 0.5

const wordsIn = (line: string) => line.split(/\s+/).filter(Boolean).length

export function breakFlags (drawn: string[], rewrapped = false): BreakFlag[] {
  const flags: BreakFlag[] = []

  if (rewrapped) flags.push('rewrapped')

  const lengths = drawn.map((line) => line.length)

  for (let at = 1; at < drawn.length - 1; at++) {
    if (wordsIn(drawn[at]!) === 1 && lengths[at]! < lengths[at - 1]! * STRANDED && lengths[at]! < lengths[at + 1]! * STRANDED) {
      flags.push('stranded-word')

      break
    }
  }

  const last = drawn.length - 1

  if (last >= 1 && wordsIn(drawn[last]!) === 1 && !drawn[last - 1]!.endsWith('-') && lengths[last]! < lengths[last - 1]! * LONE) {
    flags.push('lone-last-word')
  }

  return flags
}
