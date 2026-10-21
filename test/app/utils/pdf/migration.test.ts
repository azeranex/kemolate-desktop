import { createHash } from 'node:crypto'

import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { drawn, pdfOf, predictedImage } from './synthetic'

import type { Raster } from './synthetic'

import { readPdf } from '~/utils/pdf/extract'
import { PROBES } from '~/utils/pdf/identity'
import { knownFor, knowRowsBy } from '~/utils/pdf/known'
import { encodePng } from '~/utils/pdf/png'

/**
 * A PDF opened before its compressed pages had a second road still comes out
 * as the files it came out as then — so its work is found under its pages.
 *
 * The new road (`extract.ts`) gives a page the same pixels in a different
 * file, and a page's SHA-256 is its identity: the reading (`blocks:`), stack
 * (`layers:`), cleaning (`patches/`, `repairs-shown:`) and retouching
 * (`paint:`) of a chapter are filed under it, and a cloud workspace's rows
 * record it. Read the new way, an old chapter opens as strangers, and its work
 * is on disk under names no page has any more. `identity.ts` is the rule that
 * prevents it; these are the cases it has to get right:
 *
 * - an old local chapter, known by what this browser filed under its pages;
 * - an old cloud chapter on a computer that never held it, known by the rows;
 * - an old chapter coming back from its kept folder with most of its pages
 *   never read or thumbnailed, which must not be given up on;
 * - a book first opened the new way, opened again — the new way, and without
 *   paying for the old road;
 * - a new book, which pays for the old road on `PROBES` pages at most, and on
 *   none at all where nothing is known.
 *
 * Seam: `knownFor` over the stores as an older build left them (IndexedDB a
 * map, OPFS a list of names, the workspace's rows a function), and `readPdf`
 * given what it found. What "the old file" is comes from `encodePng` over the
 * rows — what the old road always handed a predicted Flate image.
 *
 * Bites: make `Choosing.choose` return the new file unconditionally and the
 * first three fail — the pages come out under hashes nothing is filed under.
 */
const { memory, names } = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  names: new Map<string, string[]>(),
}))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, value) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
  getMany: async (keys: string[]) => keys.map((key) => memory.get(key)),
}))

vi.mock('~/utils/opfs', () => ({
  opfsNames: async (folder: string) => names.get(folder) ?? [],
}))

/** Counts the old road: `raster` calls `encodePng` once per page it writes. */
vi.mock('~/utils/pdf/png', async (original) => {
  const real = await original<typeof import('~/utils/pdf/png')>()

  return { ...real, encodePng: vi.fn(real.encodePng) }
})

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const WS = '9c0d7e2a-6b1f-4c3e-8a55-3f2b1d0c9e77'
const BOOK = 'chapter.pdf'

/** A book of `count` compressed pages, and each page's rows. */
function book (count: number, seed = 1) {
  const rasters: Raster[] = Array.from({ length: count }, (_, at) => drawn(48 + at, 36, at % 2 ? 1 : 3, seed * 100 + at))

  return { pdf: pdfOf(rasters.map((raster) => predictedImage(raster))), rasters }
}

/** Each page's hash as the old road wrote it — what an older build filed everything under. */
const oldHashes = async (rasters: Raster[]) => Promise.all(rasters.map(async (raster) =>
  sha(await encodePng({ width: raster.width, height: raster.height, depth: raster.depth, color: raster.channels === 3 ? 2 : 0, data: raster.rows }))))

/** Read the book the way `pdfPages` does, with what the stores know; each page's hash. */
async function opened (pdf: Uint8Array, options: { reopening?: boolean } = {}) {
  const hashes: string[] = []

  for await (const { page } of readPdf(pdf, undefined, knownFor(BOOK, options))) hashes.push(sha(page!.data))

  return hashes
}

const encodes = () => vi.mocked(encodePng).mock.calls.length

beforeEach(() => {
  memory.clear()
  names.clear()
  knowRowsBy(async () => [])
})

afterEach(() => {
  vi.mocked(encodePng).mockClear()
})

describe('a PDF opened before, opened again', () => {
  it('keeps a local chapter’s reading, stack, cleaning and retouching found under its pages', async () => {
    const { pdf, rasters } = book(4)
    const [a, b, c, d] = await oldHashes(rasters)

    // As an older build left them: a thumbnail for every page, and the work.
    names.set('thumbs', [a, b, c, d].map((hash) => `${hash}.webp`))
    names.set('patches', [`${c!.slice(0, 16)}-10-20-30-40-aot-m3.png`])
    memory.set(`blocks:${WS}:${a}`, { blocks: [{ id: 'read:1', source: 'あ' }] })
    memory.set(`layers:${WS}:${b}`, { stack: ['sheet'] })
    memory.set(`repairs-shown:${WS}:${c}`, ['kept'])
    memory.set(`paint:${d}:bg`, [{ seq: 1 }])

    const pages = await opened(pdf)

    expect(pages).toEqual([a, b, c, d])
    expect(memory.get(`blocks:${WS}:${pages[0]}`)).toBeTruthy()
    expect(memory.get(`layers:${WS}:${pages[1]}`)).toBeTruthy()
    expect(memory.get(`repairs-shown:${WS}:${pages[2]}`)).toBeTruthy()
    expect(names.get('patches')![0]!.startsWith(pages[2]!.slice(0, 16))).toBe(true)
    expect(memory.get(`paint:${pages[3]}:bg`)).toBeTruthy()
  })

  it('keeps a cloud chapter’s pages on a computer that never held them, by its rows', async () => {
    const { pdf, rasters } = book(3)
    const hashes = await oldHashes(rasters)

    knowRowsBy(async () => hashes.map((hash, at) => ({ path: `vol/${BOOK}/00${at + 1}.png`, hash })))

    expect(await opened(pdf)).toEqual(hashes)
  })

  it('does not give up on a chapter back from its kept folder, however many pages are unknown', async () => {
    const { pdf, rasters } = book(PROBES + 3)
    const hashes = await oldHashes(rasters)
    const last = hashes.at(-1)!

    // Only the last page was ever read; nothing else was filed under anything.
    memory.set(`blocks:${WS}:${last}`, { blocks: [{ id: 'read:9' }] })

    expect((await opened(pdf, { reopening: true })).at(-1)).toBe(last)
  })
})

describe('a PDF opened the new way', () => {
  it('comes out the new way again, without the old road run once', async () => {
    const { pdf } = book(4)

    const first = await opened(pdf)

    expect(encodes()).toBe(0)

    // What that first open left behind: a thumbnail for every page.
    names.set('thumbs', first.map((hash) => `${hash}.webp`))

    expect(await opened(pdf, { reopening: true })).toEqual(first)
    expect(encodes()).toBe(0)
  })

  it('costs a new book the old road on at most the probes, and ends up entirely new', async () => {
    const { pdf, rasters } = book(PROBES + 3, 2)
    const old = await oldHashes(rasters)

    vi.mocked(encodePng).mockClear()

    // Something else this browser once opened, and nothing of this book.
    names.set('thumbs', [`${'f'.repeat(64)}.webp`])

    const pages = await opened(pdf)

    expect(encodes()).toBe(PROBES)
    expect(pages.some((hash) => old.includes(hash))).toBe(false)
  })
})
