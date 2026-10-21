import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { db, pages, repairs } from '~~/server/database'
import { sweep, SWEEP_GRACE_MS } from '~~/server/services/repairs'

/**
 * The repair files nothing names any more, and only those, go.
 *
 * A repair's bytes are one file per hash, shared by every row that names the
 * same picture, and rows go all the time — a block read again, a page or a
 * workspace deleted, a balloon cleaned again under the same recipe. Each of
 * those cascaded the rows and left the file, so `.data/repairs` only ever grew:
 * 28 files of 568 were named by nothing when this was written. A file that is
 * still named must never go — it is somebody's cleaning — and neither may one
 * written a moment ago, because `keep` writes the file before its row.
 *
 * Seam: `sweep`, against the real schema and a stand-in for the `repairs`
 * storage — desktop: `server/utils/repairStore.ts`, in memory here.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 27, 12)

/** The repair store, in memory: each file's bytes and when it was written. */
const files = vi.hoisted(() => new Map<string, { bytes: Buffer, mtime: Date }>())

vi.mock('~~/server/utils/repairStore', () => ({
  repairStore: {
    getKeys: async () => [...files.keys()],
    getMeta: async (key: string) => ({ mtime: files.get(key)?.mtime }),
    removeItem: async (key: string) => { files.delete(key) },
    hasItem: async (key: string) => files.has(key),
    setItemRaw: async (key: string, bytes: Buffer) => { files.set(key, { bytes, mtime: new Date() }) },
    getItemRaw: async (key: string) => files.get(key)?.bytes ?? null,
  },
}))

const hash = (n: number) => n.toString(16).padStart(64, '0')

function file (n: number, age: number) {
  files.set(`${hash(n)}.png`, { bytes: Buffer.from([n]), mtime: new Date(NOW - age) })
}

async function aPage () {
  const context = await aWorkspace()
  const [page] = await db.insert(pages).values({ workspaceId: context.workspaceId, uid: crypto.randomUUID(), path: '1.jpg', name: '1.jpg', position: 0 }).returning()

  return page!
}

async function named (pageId: number, n: number) {
  const box = { x: 0, y: 0, w: 10, h: 10 }

  await db.insert(repairs).values({ pageId, blockId: null, key: `k${n}`, hash: hash(n), from: box, box })
}

describe('sweeping repair files', () => {
  beforeEach(() => {
    reset()
    files.clear()
  })

  it('takes a file no row names, and leaves one that a row names', async () => {
    const page = await aPage()

    await named(page.id, 1)
    file(1, DAY)
    file(2, DAY)

    expect(await sweep(NOW)).toBe(1)
    expect([...files.keys()]).toEqual([`${hash(1)}.png`])
  })

  it('leaves a file written less than the grace ago — its row may not have landed yet', async () => {
    file(3, SWEEP_GRACE_MS - 1000)
    file(4, SWEEP_GRACE_MS + 1000)

    expect(await sweep(NOW)).toBe(1)
    expect([...files.keys()]).toEqual([`${hash(3)}.png`])
  })

  it('takes the files of a deleted page once nothing else names them — and keeps one another page shares', async () => {
    const gone = await aPage()
    const kept = await aPage()

    await named(gone.id, 5)
    await named(gone.id, 6)
    await named(kept.id, 6)
    file(5, DAY)
    file(6, DAY)

    // The page's rows cascade; the files stay until the sweep.
    await db.delete(pages).where(eq(pages.id, gone.id)).run()

    expect(await sweep(NOW)).toBe(1)
    expect([...files.keys()]).toEqual([`${hash(6)}.png`])
  })

  it('leaves anything in the mount that is not a repair file', async () => {
    files.set('notes.txt', { bytes: Buffer.from('x'), mtime: new Date(NOW - DAY) })

    expect(await sweep(NOW)).toBe(0)
    expect(files.has('notes.txt')).toBe(true)
  })
})
