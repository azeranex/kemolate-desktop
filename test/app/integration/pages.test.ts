import { describe, it } from 'vitest'

/**
 * A page removed here is a page removed there — the seam where "it came back"
 * lives.
 *
 * **Needs both ends**: the browser's storage and a server with migrations
 * applied. It does not mirror a module, because the bug it is written for is
 * not in one.
 *
 * ## The disagreement this exists to pin
 *
 * There are two ways a page can leave the server and they do not agree.
 * `pages.remove` deletes a row and everything cascading from it.
 * `pages.sync` — which runs on every page list change, every hash that lands
 * and every chapter open — is **additive and will not remove**, on the
 * deliberate reasoning that a short list is not evidence a page is gone and
 * must never be able to detach an evening's work by cascade.
 *
 * Both rules are defensible. What is not decided anywhere is what happens when
 * a reader removes a page in the panel: if only `sync` follows, the row
 * survives, the next `restore` hands it back, and the page returns. That would
 * be reliable rather than intermittent, which matches it being reported as
 * happening often.
 *
 * So these cases deliberately assert the *reader's* expectation — a page they
 * removed stays removed, across a reload and across a collaborator — and let
 * the implementation decide which path carries it. If they fail, they say which
 * store disagreed, which is the thing no unit test on either side can.
 *
 * ## And the other direction
 *
 * A page added while a chapter is open has to reach the server once, not twice.
 * Matching is by hash first and path second, and a hash arrives in the
 * background well after the page is on screen — so the window between "added,
 * unhashed, matched by path" and "hashed" is exactly where a duplicate row gets
 * made. The service's own header predicts it: a folder renamed wholesale looks
 * like twice as many pages until the hashes catch up.
 */

describe('a page a reader removed', () => {
  it.todo('is gone from the server as well as from the browser')
  it.todo('is still gone after a reload')
  it.todo('is still gone after a sync that does not mention it')
  it.todo('does not come back when the chapter is reopened')
  it.todo('takes its blocks and translations with it, and nothing else\'s')
  it.todo('is gone for a collaborator too')
})

describe('a page a reader added', () => {
  it.todo('reaches the server once')
  it.todo('is not filed twice when its hash lands after it was matched by path')
  it.todo('is not filed twice when the same file is added again')
  it.todo('keeps the position the reader put it in')
  it.todo('carries nothing with it, because a new page has nothing on it yet')
})

describe('a chapter opened partly', () => {
  it.todo('leaves the pages this reader did not open alone')
  it.todo('does not delete a page because one browser could not read the file')
  it.todo('does not reorder the chapter around a partial list')
})

describe('reordering, once there are two of them', () => {
  it.todo('agrees on the order after a reader drags a page')
  it.todo('shows a collaborator the same order')
  it.todo('keeps each page\'s blocks with that page rather than with its position')
})
