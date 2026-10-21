import { beforeEach, describe, expect, it } from 'vitest'

import { departed, forgetAgreed, settled } from '~/composables/useBlockSync'

/**
 * When a row leaving the local list means "delete it", and when it does not.
 *
 * **The bug these were written for is found.** They were first drafted as
 * `it.todo` on 2026-08-03, before the cause was known, on the reasoning that
 * pinning the rule at this seam would either reproduce the failure or narrow
 * where it could not be. It reproduced.
 *
 * The cause: `held` was keyed by page id alone, and a page id is `scan:<path>`
 * — the reader's own folder and nothing else. `useComic.openImages` replaces
 * the pages with fresh ones carrying `blocks: []`, keeping those very ids, and
 * the blocks only arrive afterwards from `useOcr.restore`. In the gap, `flush`
 * saw a page it recognised holding nothing and read every row of the *previous*
 * open as deleted. `forgetAgreed` would have cleared it, but that is wired to a
 * change of workspace, which opening a chapter is not.
 *
 * It destroyed two workspaces' finished work on 2026-08-09 — thirteen blocks
 * and thirteen translations on one, nine and nine plus seven hand-made compound
 * balloons on another — and matches the 2026-08-03 losses exactly: a run of one
 * DELETE per block, moments after a chapter was opened.
 *
 * The fix is the `epoch` in the key. A re-opened page has a key nothing has
 * written, so it reads as *never seen* rather than *emptied*, and nothing is
 * deleted. `epoch` is bumped by every path that replaces the pages, which is
 * already its contract — the OCR and translate runs use it to notice a chapter
 * closing underneath them.
 *
 * Seam: `departed` — given a page's rows before and after, which does the sync
 * consider gone? Not `drop`'s timer, not the fetch.
 */

/** A chapter open. Any number will do; what matters is that opening bumps it. */
const OPEN = 1
const REOPEN = 2

const PAGE = 'scan:9.jpg'

beforeEach(() => {
  forgetAgreed()
})

describe('a deletion the reader meant', () => {
  it('reports a row whose block the reader removed', () => {
    departed(OPEN, PAGE, new Set([1, 2, 3]))

    expect(departed(OPEN, PAGE, new Set([1, 3]))).toEqual([2])
  })

  it('reports nothing when the page is unchanged', () => {
    departed(OPEN, PAGE, new Set([1, 2, 3]))

    expect(departed(OPEN, PAGE, new Set([1, 2, 3]))).toEqual([])
  })

  it('reports nothing for a block that never had a row', () => {
    // Row-less blocks are filtered out before they reach here, so a page of
    // them is an empty set — and an empty set is not an emptied page.
    expect(departed(OPEN, PAGE, new Set())).toEqual([])
  })
})

describe('a deletion nobody meant', () => {
  it('reports nothing for rows a server read has just settled', () => {
    settled(OPEN, PAGE, [1, 2, 3])

    expect(departed(OPEN, PAGE, new Set([1, 2, 3]))).toEqual([])
  })

  it('compares a page only with itself, so two pages cannot cancel each other', () => {
    departed(OPEN, 'scan:1.jpg', new Set([1, 2]))

    // Turning to another page: its own rows are different, and none of page
    // one's have gone anywhere.
    expect(departed(OPEN, 'scan:2.jpg', new Set([3, 4]))).toEqual([])
    expect(departed(OPEN, 'scan:1.jpg', new Set([1, 2]))).toEqual([])
  })

  it('reports nothing when the workspace changed under it', () => {
    departed(OPEN, PAGE, new Set([1, 2, 3]))

    // `useWorkspaceReset` — the same chapter opened in another workspace gives
    // the same page keys against another workspace's rows.
    forgetAgreed()

    expect(departed(OPEN, PAGE, new Set())).toEqual([])
  })
})

describe('the case that had already destroyed data', () => {
  it('reports nothing when the chapter is opened again onto an empty page', () => {
    // The workspace's rows, loaded by `useOcr.restore` during the first open.
    departed(OPEN, PAGE, new Set([630, 631, 632]))

    // `openImages` replaces the pages with fresh ones — same ids, no blocks —
    // and `flush` runs before `restore` has put anything back. Before the
    // epoch was in the key this returned all three, and `drop` deleted them.
    expect(departed(REOPEN, PAGE, new Set())).toEqual([])
  })

  it('still reports a real deletion made after the chapter was re-opened', () => {
    // The fix must not buy safety by never deleting anything again: once the
    // new open has seen the page hold rows, losing one is still a deletion.
    departed(OPEN, PAGE, new Set([630, 631, 632]))
    departed(REOPEN, PAGE, new Set())
    departed(REOPEN, PAGE, new Set([630, 631, 632]))

    expect(departed(REOPEN, PAGE, new Set([630, 632]))).toEqual([631])
  })

  it('reports nothing for a page whose blocks never finished loading', () => {
    // A restore that failed, or one still in flight. The page is empty and
    // nothing has ever been recorded for it this open, so there is nothing to
    // have left.
    expect(departed(OPEN, PAGE, new Set())).toEqual([])
    expect(departed(OPEN, PAGE, new Set())).toEqual([])
  })
})
