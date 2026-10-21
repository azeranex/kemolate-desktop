import { describe, it } from 'vitest'

/**
 * Who is in the comic, and why a character cannot change sex halfway down it.
 *
 * **Needs the database harness.**
 *
 * The cast is the glossary's other half. The glossary keeps a name spelled the
 * same way twice; this keeps track of who the name belongs to. `merge` fills
 * blanks and never revises, and a pinned row is untouched — because looking at
 * a row the model proposed and leaving it is a decision.
 *
 * Two defects found on 2026-08-03 sit under these cases: `merge` decided
 * pinnedness from a read taken before an `await`, so a row pinned in that gap
 * was overwritten; and `save` deduped case-insensitively against an index that
 * compares bytes, so correcting a name's capitalisation left two rows for one
 * character. Both are invisible to a single-threaded reading.
 *
 * Seam: `merge`, `save`, `members`.
 */

describe('merge', () => {
  it.todo('adds a character the cast has not met')
  it.todo('fills a blank the model can now answer')
  it.todo('never revises a fact already recorded')
  it.todo('leaves a pinned member alone')
  it.todo('leaves a member pinned between the read and the write alone')
  it.todo('keeps a name per language while the person stays one person')
})

describe('save', () => {
  it.todo('pins everything it writes, because leaving a proposed row is a decision')
  it.todo('replaces a row when its name is recapitalised rather than duplicating it')
  it.todo('removes a member the panel dropped')
  it.todo('refuses to grow the cast past its ceiling')
})
