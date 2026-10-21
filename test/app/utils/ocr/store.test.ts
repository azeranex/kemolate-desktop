import { describe, it } from 'vitest'

/**
 * Model weights, fetched once per install and kept where they can be looked at.
 *
 * **Needs the OPFS shim the nuxt project already stands up**, plus a stub for
 * the fetch — no real download belongs in a test suite.
 *
 * These files are the largest thing the app moves: three quarters of a gigabyte
 * for a full set, and the difference between fetching once and fetching per
 * origin is what `/api/models/**` exists for. So the interesting cases are all
 * about *not* fetching — a hit that is served, a concurrent asker who waits
 * rather than starting a second download, and an adopted file from the old
 * Cache API that moves house instead of coming down the wire again.
 *
 * The failure worth guarding hardest is the quiet one: a partial or corrupt
 * blob served as a model. It does not throw at the store, it throws inside ONNX
 * somewhere far away, or worse it loads and infers nonsense.
 *
 * Seam: `readModel` and `writeModel`.
 */

describe('reading', () => {
  it.todo('answers a model already in the store without fetching')
  it.todo('answers nothing for a key the store has never held')
  it.todo('adopts a model left in the old Cache API rather than fetching it again')
  it.todo('adopts it once, and reads from the new home after that')
})

describe('writing', () => {
  it.todo('keeps a model under the path that names it')
  it.todo('keeps two revisions of one model apart')
  it.todo('survives a store that refuses the write, at the cost of the next fetch')
})

describe('what must never be served', () => {
  it.todo('does not answer with a blob shorter than the one that was written')
  it.todo('does not leave a half-written model readable after a failed write')
})
