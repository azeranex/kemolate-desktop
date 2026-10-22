/**
 * How loud a line was lettered in the original — desktop.
 *
 * A standard size sets every ordinary line alike, which is right for nearly all
 * of them and wrong for the shout: the artist drew "WHAT?!" twice the size of
 * the dialogue around it, and a translation set at the standard reads as said
 * calmly. A letterer reads the size off the original, and so does this: the
 * source's characters measured against the chapter's ordinary ones, and a line
 * whose characters are clearly bigger is set that much over the standard.
 *
 * What is measured is the pitch of a character — the side of the square each
 * one would take if the block's box were shared out evenly among them. Rough,
 * and rough in the same way for every block of a chapter, which is what a ratio
 * needs: a detector's box is a little looser than its text everywhere. Whatever
 * the original's direction, since a column of eight and a line of eight share
 * their box out alike. Measured on the box the text was *found* in, never the
 * lettering frame or the room — those are typesetting decisions, not evidence.
 *
 * The chapter's ordinary pitch is the median over every dialogue block and
 * caption, so one page of shouting is loud against the chapter, not normal
 * against itself. Too few blocks to say what ordinary is, and nothing is
 * emphasised.
 *
 * A big *balloon* is not evidence of anything. The artist leaves room; the
 * room is not the voice. That is the case this exists to tell apart.
 */
import type { Block, ComicPage } from '~/composables/useComic'

import { standardApplies } from '#shared/utils/lettering'

/** A line's characters must be this much bigger than ordinary to count as emphasised. */
export const EMPHASIS_FROM = 1.3

/** The most a measured emphasis sets a line over the standard — past this it is a title, set by hand. */
export const EMPHASIS_MAX = 1.8

/** How many blocks a chapter needs before its ordinary size means anything. */
export const EMPHASIS_QUORUM = 4

/** The fewest characters a block needs to be measured: one glyph in a box says nothing about its size. */
const FEWEST = 2

const charactersIn = (text: string) => [...text].filter((char) => /\S/.test(char)).length

/**
 * A block's character pitch as a share of its page's width, or null where it
 * cannot be told: too few characters, or a page whose size is not known.
 * A joined balloon is measured over its parts, each in its own box.
 */
export function pitchOf (block: Block, page: { width: number, height: number }): number | null {
  if (!page.width || !page.height) return null

  const parts = block.children?.length ? block.children : [block]
  let area = 0
  let characters = 0

  for (const part of parts) {
    const count = charactersIn(part.source)

    if (!count) continue

    area += (part.w / 100) * page.width * (part.h / 100) * page.height
    characters += count
  }

  if (characters < FEWEST || area <= 0) return null

  return Math.sqrt(area / characters) / page.width
}

/** Whether a block's size says anything about the chapter's ordinary lettering. */
const ordinary = (block: Block) => !block.hidden && standardApplies(block.type) && block.type !== 'garbage'

/** The chapter's ordinary character pitch — the median of its dialogue and captions — or null with too few. */
export function ordinaryPitch (pages: readonly ComicPage[], sizeOf: (page: ComicPage) => { width: number, height: number }): number | null {
  const pitches: number[] = []

  for (const page of pages) {
    const size = sizeOf(page)

    for (const block of page.blocks) {
      if (!ordinary(block)) continue

      const pitch = pitchOf(block, size)

      if (pitch !== null) pitches.push(pitch)
    }
  }

  if (pitches.length < EMPHASIS_QUORUM) return null

  pitches.sort((a, b) => a - b)

  const middle = pitches.length / 2

  return pitches.length % 2 ? pitches[Math.floor(middle)]! : (pitches[middle - 1]! + pitches[middle]!) / 2
}

/**
 * How much over the standard the original says a line is, to a tenth: 1 for an
 * ordinary line, or one whose size cannot be told; up to `EMPHASIS_MAX` for one
 * lettered clearly bigger than the chapter's usual. Sound effects are not held
 * to the standard and have no emphasis to take.
 */
export function measuredEmphasis (block: Block, page: { width: number, height: number }, usual: number | null): number {
  if (usual === null || !ordinary(block)) return 1

  const pitch = pitchOf(block, page)

  if (pitch === null) return 1

  const ratio = pitch / usual

  return ratio < EMPHASIS_FROM ? 1 : Math.min(EMPHASIS_MAX, Math.round(ratio * 10) / 10)
}

/** What a line is set at over the standard: the multiple somebody chose, or the measured one. */
export function emphasisOf (chosen: number | null, measured: number): number {
  return chosen ?? measured
}
