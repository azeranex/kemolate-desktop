import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePreviews, previewName, previewSize, sketchName } from '~/utils/raster/previews'

/**
 * The preview run: every page of a chapter made ready to be turned to, on the
 * background decoders, while the workspace page keeps starting it again.
 *
 * It is started again whenever a page gains its hash or its width, the window
 * changes size or a balloon is cleaned — during an open, every second or so.
 * A stopped run threw away the preview it was making, 590 ms of work on a
 * 3732 × 5197 page, and the run that replaced it made the same one again. It
 * made one page at a time, on one decoder, and listed the whole previews folder
 * after every file it wrote.
 *
 * Seam: `makePreviews` over a previews folder held in a map, with the decoder
 * replaced by one whose every answer the test gives by hand.
 */

const { stored, listings, asked, jobs } = vi.hoisted(() => ({
  /** The previews folder: name → file. */
  stored: new Map<string, Blob>(),
  listings: { count: 0 },
  /** Each preview asked of the decoder, with the means to answer it. */
  asked: [] as { key: string, answer: (blob: Blob) => void }[],
  /** Each sketch or cleaning asked of the decoder. */
  jobs: [] as string[],
}))

vi.mock('~/utils/raster/decoder', () => ({
  jobKey: (what: string) => what,
  scanPreview: (key: string) => new Promise<Blob>((resolve) => { asked.push({ key, answer: resolve }) }),
  scanJob: async (key: string, _file: Blob, job: { what: string }) => {
    jobs.push(`${job.what} ${key}`)

    return { width: 1, height: 1, blob: new Blob([job.what]) }
  },
}))

vi.mock('~/utils/opfs', () => ({
  opfsRead: async (_folder: string, name: string) => {
    const blob = stored.get(name)

    return blob ? new File([blob], name) : null
  },
  opfsWrite: async (_folder: string, name: string, blob: Blob) => {
    stored.set(name, blob)

    return true
  },
  opfsNames: async () => {
    listings.count++

    return [...stored.keys()]
  },
  opfsDir: async () => ({ removeEntry: async (name: string) => { stored.delete(name) } }),
}))

vi.mock('~/utils/idb', () => ({ idb: { set: async () => {} } }))

const PAGE = { width: 3732, height: 5197 }
const FIT = { width: 1930, height: 2688 }
const SIZE = previewSize(PAGE, FIT)

/** A scan hash, as every file here is named by — 64 hex digits. */
const hash = (n: number) => n.toString(16).padStart(64, '0')

const page = (n: number) => ({ url: `blob:${n}`, file: new File([`page ${n}`], `${n}.jpg`), hash: hash(n), page: PAGE, fit: FIT })

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  stored.clear()
  listings.count = 0
  asked.length = 0
  jobs.length = 0
})

// Whatever a test left being made is finished, as the decoder always finishes
// it: a file still in the making would otherwise be waited on by the next test.
afterEach(async () => {
  for (const one of asked) one.answer(new Blob(['late']))

  await settle()
})

describe('the preview run', () => {
  it('keeps the preview a stopped run was making, and the run after it does not make it again', async () => {
    const pages = [page(1), page(2)]
    const first = makePreviews('', pages, () => false, 1)

    await vi.waitFor(() => expect(asked).toHaveLength(1))

    // The chapter moved: the watcher stops the run and starts another while
    // page 1's preview is still being made.
    first.stop()

    const second = makePreviews('', pages, () => false, 1)

    await settle()

    const made = new Blob(['page 1, at 2688'])

    asked[0]!.answer(made)

    await vi.waitFor(() => expect(asked).toHaveLength(2))
    asked[1]!.answer(new Blob(['page 2, at 2688']))
    await vi.waitFor(() => expect(stored.has(sketchName(hash(2), ''))).toBe(true))

    second.stop()

    // Made once, and kept as the decoder made it — byte for byte the same file.
    expect(asked.map((one) => one.key)).toEqual(['blob:1', 'blob:2'])
    expect(stored.get(previewName(hash(1), SIZE))).toBe(made)
  })

  it('keeps what a run finishes after it was stopped, for the next run to find', async () => {
    const run = makePreviews('', [page(1)], () => false, 1)

    await vi.waitFor(() => expect(asked).toHaveLength(1))
    run.stop()

    const made = new Blob(['page 1, at 2688'])

    asked[0]!.answer(made)
    await vi.waitFor(() => expect(stored.get(previewName(hash(1), SIZE))).toBe(made))

    // Stopped, so nothing more is started for it: not the sketch.
    await settle()
    expect(jobs).toEqual([])

    const again = makePreviews('', [page(1)], () => false, 1)

    await vi.waitFor(() => expect(stored.has(sketchName(hash(1), ''))).toBe(true))
    again.stop()

    expect(asked).toHaveLength(1)
  })

  it('makes as many previews at once as it is given lanes, nearest the page on screen first', async () => {
    const run = makePreviews('', [1, 2, 3, 4, 5].map(page), () => false, 3)

    await vi.waitFor(() => expect(asked).toHaveLength(3))
    await settle()

    expect(asked.map((one) => one.key)).toEqual(['blob:1', 'blob:2', 'blob:3'])

    asked[1]!.answer(new Blob(['2']))

    await vi.waitFor(() => expect(asked).toHaveLength(4))
    expect(asked[3]!.key).toBe('blob:4')

    run.stop()
  })

  it('lists the folder once a run, and still replaces a page’s preview at another size', async () => {
    const old = `${hash(1)}@1664.webp`

    stored.set(old, new Blob(['page 1, at an old size']))

    const run = makePreviews('', [1, 2, 3].map(page), () => false, 1)

    for (let at = 0; at < 3; at++) {
      await vi.waitFor(() => expect(asked).toHaveLength(at + 1))
      asked[at]!.answer(new Blob([`page ${at + 1}`]))
    }

    await vi.waitFor(() => expect(stored.has(sketchName(hash(3), ''))).toBe(true))
    run.stop()

    // Six files written — three previews, three sketches — and one listing.
    expect(listings.count).toBe(1)
    expect(stored.has(old)).toBe(false)
    expect(stored.has(previewName(hash(1), SIZE))).toBe(true)
  })
})
