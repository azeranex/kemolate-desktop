import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { bitmap, Canvas, hold, log, release, reset } from '../utils/ocr/harness'

import type { RepairRow } from '#shared/utils/repairs'

import { useClean } from '~/composables/useClean'
import { useComic } from '~/composables/useComic'

/**
 * "Clean all", as the server and the model see it.
 *
 * A run over a cloud workspace asks the server what somebody else has already
 * cleaned before cleaning anything itself. It used to ask for the chapter's
 * whole repair list again on every page — forty requests for forty pages, each
 * answered with the same rows — and then brought the repairs it wanted down
 * one after another. And a run whose chapter was closed under it went on
 * cleaning the page in hand, then wrote, showed and sent up every repair on it.
 *
 * Seams: the server is `registerEndpoint` (the app's `$fetch` is the test
 * environment's, so stubbing the global would not reach it), the disk is a map
 * behind `readPatch`/`writePatch`, and the model is the stand-in runtime of
 * `harness.ts`, whose runs a test can hold open. The chapter closing is
 * `useComic`'s own epoch moving, which is what every stop in the app is.
 *
 * Desktop: the two tests that do not need a server. The web build's other three
 * were about a cloud workspace's repairs — the list asked for once a run, the
 * downloads six at a time, a page's downloads dropped when its chapter closed —
 * and there is no server here to keep repairs on. The server stays, answering
 * nothing, so "nothing was sent" is still a thing a test can say.
 */

const { shared, disk, wrote, server } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    // A local workspace, the only kind there is here — see `keepsRepairs`.
    shared: ref<{ role: string } | null>(null),
    disk: new Map<string, Blob>(),
    wrote: [] as string[],
    server: {
      rows: [] as RepairRow[],
      lists: 0,
      puts: 0,
      deletes: 0,
      downloads: 0,
      flying: 0,
      peak: 0,
      // Downloads wait on this where a test sets it, and otherwise on `LINGER`.
      gate: null as Promise<void> | null,
    },
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

mockNuxtImport('useShared', () => () => ({
  shared,
  // Page n's row is n — see `page`.
  pageRowOf: (target: { id: string }) => (shared.value ? Number(target.id.replace(/\D/g, '')) : null),
}))

// Nobody has corrected a mask, and nothing asks the server about corrections.
mockNuxtImport('useMaskEdits', () => () => ({
  load: async () => [],
  chapterEdits: async () => null,
  editsFrom: () => null,
}))

mockNuxtImport('readPatch', () => async (key: string) => disk.get(key) ?? null)

mockNuxtImport('writePatch', () => async (key: string, image: Blob) => {
  disk.set(key, image)
  wrote.push(key)
})

mockNuxtImport('sessionFor', async () => {
  const { session } = await import('../utils/ocr/harness')

  return async () => session
})

mockNuxtImport('ortOnce', async () => {
  const { runtime } = await import('../utils/ocr/harness')

  return async () => runtime
})

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

registerEndpoint('/api/workspaces/ws/repairs', {
  method: 'GET',
  handler: () => {
    server.lists++

    return server.rows
  },
})

registerEndpoint('/api/workspaces/ws/repairs', {
  method: 'PUT',
  handler: (event) => {
    server.puts++

    const query = getQuery(event)

    return { key: String(query.key), hash: 'f'.repeat(64), pageId: Number(query.pageId), blockId: null, from: { x: 0, y: 0, w: 1, h: 1 }, box: { x: 0, y: 0, w: 1, h: 1 }, createdAt: 1 }
  },
})

registerEndpoint('/api/workspaces/ws/repairs', {
  method: 'DELETE',
  handler: () => {
    server.deletes++

    return null
  },
})

const W = 1000
const H = 1000

/** Page n of a chapter, with `blocks` upright balloons set out in a grid no two crops of which meet. */
function page (n: number, blocks: number): ComicPage {
  return {
    id: `scan:${n}.jpg`,
    name: `${n}.jpg`,
    blocks: Array.from({ length: blocks }, (_, i) => ({
      id: `block:${n * 100 + i}`,
      type: 'bubble' as const,
      x: 4 + (i % 4) * 24,
      y: 4 + Math.floor(i / 4) * 24,
      w: 12,
      h: 8,
      source: '',
      translation: '',
      confidence: 100,
      hidden: false,
    })),
    scan: { url: `blob:${n}`, file: new File([String(n)], `${n}.jpg`), width: W, height: H, hash: String(n).repeat(64) },
  }
}

/**
 * How long a download takes where no test holds it: long enough that every one
 * the pool starts together is still in flight when the last of them arrives,
 * however slowly a loaded machine gets each request to its handler.
 */
const LINGER = 50

/** What the server keeps, and a download for each of them. */
const offered: (() => void)[] = []

function offer (rows: RepairRow[]) {
  server.rows = rows

  for (const row of rows) {
    offered.push(registerEndpoint(`/api/workspaces/ws/repairs/${row.hash}`, {
      method: 'GET',
      handler: async () => {
        server.downloads++
        server.flying++
        server.peak = Math.max(server.peak, server.flying)

        await (server.gate ?? new Promise((resolve) => setTimeout(resolve, LINGER)))

        server.flying--

        return PNG
      },
    }))
  }
}

/** Every repair on screen, by page, as block ids. */
function shown (patches: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(Object.entries(patches).map(([id, onPage]) => [id, Object.keys(onPage).sort()]))
}

describe('Clean all', () => {
  // One per test: a stopped scope runs nothing, silently.
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    reset()
    disk.clear()
    wrote.length = 0
    shared.value = null
    Object.assign(server, { rows: [], lists: 0, puts: 0, deletes: 0, downloads: 0, flying: 0, peak: 0, gate: null })

    vi.stubGlobal('OffscreenCanvas', Canvas)
    vi.stubGlobal('createImageBitmap', async () => bitmap(W, H))
    // The test environment's `Blob` and its `URL` disagree about which `Blob`
    // is real; the URL is not what is under test.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shown')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { pages, at } = useComic()

    pages.value = []
    at.value = 0
  })

  afterEach(() => {
    release()
    scope.stop()

    for (const forget of offered.splice(0)) forget()

    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function cleaner () {
    const clean = scope.run(() => useClean())!

    clean.settings.value = { model: 'aot', segmenter: false }
    clean.patches.value = {}

    return clean
  }

  it('keeps nothing of a page whose balloons were still in the model when the chapter closed', async () => {
    const { cleanAll, patches, error } = cleaner()
    const { pages, epoch } = useComic()
    const chapter = [page(1, 2), page(2, 1)]

    // Nothing on the server: every balloon is cleaned here.
    offer([])
    pages.value = chapter
    hold()

    const cleaning = cleanAll()

    await vi.waitFor(() => expect(log).toContain('run 1'))

    epoch.value++
    release()
    await cleaning

    expect(wrote).toEqual([])
    expect(shown(patches.value)).toEqual({})
    expect(server.puts).toBe(0)
    // The balloon made ready behind the first was never run, and the next page
    // was never cut out.
    expect(log.filter((line) => line.startsWith('run'))).toEqual(['run 1'])
    // Stopped, which is not the same as failed.
    expect(error.value).toBeNull()
  })

  it('asks nothing of the server for a local workspace, and sends nothing up', async () => {
    const { cleanAll, patches } = cleaner()
    const { pages } = useComic()
    const target = page(1, 2)

    shared.value = null
    pages.value = [target]

    await cleanAll()

    expect(server.lists + server.downloads + server.puts + server.deletes).toBe(0)
    // Cleaned here and kept here.
    expect(wrote).toHaveLength(2)
    expect(shown(patches.value)[target.id]).toHaveLength(2)
  })
})
