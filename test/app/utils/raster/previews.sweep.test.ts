import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sweepPreviews } from '~/utils/raster/previews'

/**
 * Deleting a workspace takes the page previews only it was using.
 *
 * A preview is filed under its scan's hash, and two workspaces can hold the
 * same scan — so a preview belongs to whichever workspaces name it, and goes
 * only when none does. Each workspace's `previews:<id>` record is deleted with
 * it (it is in `WORKSPACE_OWNED`); this is the sweep that follows.
 *
 * Seam: `sweepPreviews`, over an IndexedDB and a previews folder held in maps.
 */

const records = new Map<string, unknown>()
const files = new Set<string>()

vi.mock('~/utils/idb', () => ({
  idb: {
    keys: async (prefix: string) => [...records.keys()].filter((key) => key.startsWith(prefix)),
    get: async (key: string) => records.get(key),
  },
}))

vi.mock('~/utils/opfs', () => ({
  opfsNames: async () => [...files],
  opfsDir: async () => ({ removeEntry: async (name: string) => { files.delete(name) } }),
  opfsRead: async () => null,
  opfsWrite: async () => true,
}))

/** A scan hash, as every file here is named by — 64 hex digits. */
const h = (name: string) => [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)

describe('sweeping previews after a workspace is deleted', () => {
  beforeEach(() => {
    records.clear()
    files.clear()
  })

  it('takes a preview no workspace names, and keeps one another workspace still uses', async () => {
    // Workspace B is still here and shares scan `shared` with the deleted A,
    // whose record has already gone.
    records.set('previews:B', [h('shared'), h('b-only')])
    files.add(`${h('shared')}@2816.webp`)
    files.add(`${h('shared')}@2816~abc.webp`)
    files.add(`${h('shared')}#sketch~abc.webp`)
    files.add(`${h('b-only')}@2816.webp`)
    files.add(`${h('a-only')}@2816.webp`)
    files.add(`${h('a-only')}#sketch.webp`)

    await sweepPreviews()

    expect([...files].sort()).toEqual([
      `${h('b-only')}@2816.webp`,
      `${h('shared')}#sketch~abc.webp`,
      `${h('shared')}@2816.webp`,
      `${h('shared')}@2816~abc.webp`,
    ].sort())
  })

  it('reads only the preview records, not everything else in the store', async () => {
    records.set('blocks:B:a-only', [])
    files.add(`${h('a-only')}@2816.webp`)

    await sweepPreviews()

    expect(files.size).toBe(0)
  })
})
