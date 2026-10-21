import { describe, it } from 'vitest'

/**
 * The page-wide segmentation, held so a chapter does not pay for it per block.
 *
 * **Needs a stubbed session** — no ONNX run belongs in a test. What is under
 * test is the holding, not the model.
 *
 * `segmentPage` reads the whole page at once because the model was trained on
 * full pages and because one inference for a page beats one per balloon — the
 * file puts that at the difference between five seconds and a minute. Cleaning
 * then asks for a slice per block, which is a dozen callers wanting one answer,
 * often within the same frame. `segmentedPage` is the layer that makes that one
 * run.
 *
 * It caches the *promise*, not the result, which is the detail worth pinning:
 * two blocks asking while the inference is in the air must wait on the same one
 * rather than starting a second. And it drops the entry when that promise
 * rejects, because a cached failure is a page nobody can retry past.
 *
 * The eviction is small on purpose — a `Segmented` is four megabytes, so a
 * chapter's worth held at once is not a cache, it is a leak.
 *
 * Seam: `segmentedPage`.
 */

describe('one run per page', () => {
  it.todo('runs the model once for a page however many blocks ask')
  it.todo('hands two callers racing for one page the same promise')
  it.todo('answers a later caller from the held result without running again')
  it.todo('runs again for a different page')
  it.todo('keys on the scan, so the same page in another workspace is the same answer')
})

describe('forgetting', () => {
  it.todo('drops a run that threw, so the next caller may try again')
  it.todo('evicts the oldest page once a third is asked for')
  it.todo('keeps the page being worked on rather than the one before it')
})

describe('what it does not promise', () => {
  it.todo('does not hold a page across a chapter being replaced')
})
