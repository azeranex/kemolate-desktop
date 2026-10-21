/**
 * Where a translation's lettering sits, as arithmetic — and nothing that needs
 * a database to answer.
 *
 * Its own file for one reason, and it is a testing reason rather than a
 * structural one: `translations.ts` imports `db`, and `server/database/client`
 * opens a real `DatabaseSync` at module load. Anything importing these two from
 * there would stand a database up inside `test/unit`, which is the sub-second
 * project that exists precisely so it does not have to — the same refusal
 * `access.test.ts` sets out for `contextFor`.
 *
 * They are worth the file because they are where the distinction this whole
 * feature turns on would quietly die. A frame is null throughout when the
 * lettering sits on its block, and a row of numbers — zeroes included — when it
 * has a box of its own. One `??` rewritten as `||` in either function collapses
 * a frame centred on the page's left edge into "never moved", and puts the
 * balloon back where the detector found it. The types cannot catch that; the
 * tests beside this file can.
 */
import type { TranslationEntry } from './translations'
import type { Translation } from '~~/server/database'

/**
 * The columns that say where the lettering sits, and nothing else — compared one
 * by one, `quad` excepted, which is an array and gets its own comparison below.
 *
 * The whole of a block's box shape. The lean is in here and not left out as a
 * detail: `toBoxed` records `quad` only where a corner has actually been pulled,
 * so a frame that has merely been leant carries no corner offsets and cannot be
 * reconstructed from the rest. Drop `skewX`/`skewY` from this list and a leant
 * sound effect compares equal to an upright one, so the lean is never written
 * and comes back straight for everybody but the person who leant it.
 */
const BOX = ['cx', 'cy', 'w', 'h', 'angle', 'skewX', 'skewY'] as const

/**
 * The lettering's box as the row will hold it.
 *
 * Absent collapses to null here, which is the whole of the "it sits on the
 * block" contract: the browser is handed these values with the page and sends
 * them back with it, so a missing field means the balloon has no box of its own
 * — never "do not touch it". Read `sameBox` next to this; the two have to agree
 * about that collapse or a page that has not moved is rewritten every settle.
 *
 * `??` and never `||`, in every line. Nought is a place a balloon can honestly
 * be — lettering may hang off the left edge, so a frame centred on the border
 * has a centre of nought — and `||` would file it as having no frame at all.
 */
export function boxOf (entry: TranslationEntry) {
  return {
    cx: entry.cx ?? null,
    cy: entry.cy ?? null,
    w: entry.w ?? null,
    h: entry.h ?? null,
    angle: entry.angle ?? null,
    skewX: entry.skewX ?? null,
    skewY: entry.skewY ?? null,
    quad: entry.quad ?? null,
  }
}

/**
 * Whether the lettering is already where this entry puts it.
 *
 * Exact equality on the numbers, which is right and not a rounding hazard: the
 * browser is comparing against values this row handed it, and a JSON double and
 * a SQLite `REAL` are the same float64 all the way round. A tolerance here would
 * instead swallow the one-unit nudge a letterer can plainly see.
 */
export function sameBox (row: Translation, entry: TranslationEntry): boolean {
  for (const key of BOX) if ((row[key] ?? null) !== (entry[key] ?? null)) return false

  const left = row.quad ?? null
  const right = entry.quad ?? null

  if (left === null || right === null) return left === right

  return left.length === right.length && left.every((value, index) => value === right[index])
}
