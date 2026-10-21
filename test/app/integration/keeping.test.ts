import { describe, it } from 'vitest'

/**
 * Two stores holding overlapping truth, and the switch that moves work between
 * them.
 *
 * **Needs both ends**: the browser's storage as the nuxt project provides it,
 * and a server with the migrations applied. It does not mirror a module,
 * because what it covers is the *agreement* between two of them.
 *
 * ## Why this cannot be two unit tests
 *
 * A promote is not one call, it is a claim followed by everything that was
 * waiting on the record pushing itself: the pages, the blocks, the
 * translations, the layer stack. Each of those writers is testable alone, and
 * none of them can answer the only question a reader has — *did anything get
 * left behind?* A block that never made the trip is not a failed request, it is
 * a request nobody made, and no test of a writer can see the gap.
 *
 * The same in reverse, and worse. A demote deletes the record, and seven tables
 * cascade from it. What must survive is everything the browser holds: the
 * scans, the reading, the paint, the page order. The panel says so in as many
 * words — "the pages, the reading and the paint are still here" — and that
 * sentence is either true or the app has just deleted somebody's afternoon on
 * their behalf. It is a claim about two stores at once, so it is a test about
 * two stores at once.
 *
 * ## The one that is easy to get wrong
 *
 * A round trip. Local → cloud → local should leave a reader exactly where they
 * started, and the interesting failure is not loss but *duplication* — a
 * promote that re-pushes blocks the server already had, or a demote and
 * re-promote that files the reading twice under two page rows.
 */

describe('promoting carries the work up', () => {
  it.todo('creates the workspace and its pages')
  it.todo('sends the blocks that only existed in this browser')
  it.todo('sends the translations with them')
  it.todo('sends the layer stack, and the paint filed under it')
  it.todo('leaves nothing behind that the browser was holding')
  it.todo('pressed twice, makes one workspace and one set of rows')
})

describe('demoting leaves the browser whole', () => {
  it.todo('deletes the record and everything the cascade reaches')
  it.todo('keeps the scans, which never went up in the first place')
  it.todo('keeps the reading in this browser\'s own cache')
  it.todo('keeps the paint')
  it.todo('keeps the page order and the names the reader gave them')
  it.todo('leaves a workspace that still opens and still works')
})

describe('the round trip', () => {
  it.todo('local to cloud and back leaves the same chapter open')
  it.todo('files no block twice on the way back up')
  it.todo('files no translation twice')
  it.todo('does not resurrect a page the reader removed while it was local')
})

describe('when half of it fails', () => {
  it.todo('a promote that fails partway leaves the workspace local and says so')
  it.todo('a promote that fails partway does not leave rows nobody can reach')
  it.todo('a demote refused by the server changes nothing in this browser')
})
