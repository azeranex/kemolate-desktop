/**
 * An export's finished pages, kept on disk until the download is made of them.
 *
 * Every page used to stay in memory until the last was done — a sixty-page PNG
 * export held about 0.9 GB of files before the archive was put together. Here
 * each page is written into the private filesystem as it is finished, and the
 * export is built from the files that come back: a `File` out of OPFS is a
 * reference to bytes on disk, and a `Blob` made of such files is a list of
 * references, so the download is read from disk by the browser and the tab
 * holds only the pages still being encoded. The alternatives were weighed and
 * both are worse. Streaming the archive straight into a file needs the reader
 * to pick where it goes before anything is made, and only Chromium can ask;
 * leaving the pages to the browser's own blob store works only as far as that
 * store decides to page to disk, which Chrome does past a limit sized to the
 * machine and nobody else promises.
 *
 * Each export is a folder of its own under `exports/`, and the files have to
 * outlive the export by a little: `download` hands the browser a URL onto the
 * finished `Blob` and the browser reads it after this returns, from these very
 * files — delete them first and the download fails. So a finished export's
 * folder is deleted a few minutes later (`settle`), and one that was stopped or
 * failed straight away (`discard`).
 *
 * A tab closed in between leaves a folder behind — and closing the tab is how
 * most exports end — so every export first sweeps the ones nobody is holding,
 * and so does the app once a session (`sweepExports`). "Holding" is a Web Lock
 * per export, taken before its folder exists and let go after the folder is
 * gone: the one signal that outlives neither a closed tab nor a crashed one,
 * and that another tab can read. Where there are no locks, a folder over an
 * hour old is taken to be abandoned.
 *
 * Where the private filesystem will not take a page — none to be had, or the
 * disk is full — the page stays in memory as it always did, and the export is
 * made anyway.
 */
import { opfsDir, opfsUsable } from '../opfs'

const FOLDER = 'exports'
const LOCK = 'kemolate-export:'

/** How long a finished export's files are kept, for the browser to read them into the download. */
const GRACE = 5 * 60_000

/** Where no locks can say which exports are alive: a folder this old belongs to none. */
const ABANDONED = 60 * 60_000

export interface Spill {
  /** Put a finished page on disk and hand back the file there — or the page as it came, where the disk would not take it. */
  keep: (name: string, data: Blob) => Promise<Blob>
  /** Delete this export's files now: nothing was made of them. */
  discard: () => Promise<void>
  /** Delete them once the download has had time to read them. */
  settle: () => void
}

/** Nowhere to put anything: every page stays in memory. */
const inMemory: Spill = {
  keep: async (_, data) => data,
  discard: async () => {},
  settle: () => {},
}

/** When an export's folder was started, from its name — see `openSpill`. */
const startedAt = (name: string) => Number.parseInt(name.split('-')[0] ?? '', 36)

/** The exports some tab is still holding, by folder name — or null where nobody can say. */
async function held (): Promise<Set<string> | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) return null

  const state = await navigator.locks.query().catch(() => null)

  if (!state) return null

  const names = [...(state.held ?? []), ...(state.pending ?? [])].map((lock) => lock.name ?? '')

  return new Set(names.filter((name) => name.startsWith(LOCK)).map((name) => name.slice(LOCK.length)))
}

/** Delete every export folder nobody is holding, but `mine`. */
async function sweep (root: FileSystemDirectoryHandle, mine: string | null) {
  const alive = await held()
  const gone: string[] = []

  try {
    for await (const entry of root.values()) {
      if (entry.kind !== 'directory' || entry.name === mine) continue

      const kept = alive ? alive.has(entry.name) : Date.now() - startedAt(entry.name) < ABANDONED

      if (!kept) gone.push(entry.name)
    }
  } catch {
    // A listing that fails leaves the leftovers for the next sweep to find.
  }

  for (const name of gone) await root.removeEntry(name, { recursive: true }).catch(() => {})
}

/**
 * Clear away what earlier exports left behind — once a session, a little after
 * the app opens (`usePageExport`).
 *
 * Not only for the crash. The usual export ends with its tab being closed, and
 * a tab closed inside the grace period takes its `settle` timer with it: in
 * testing, nine exports in a row left nine folders, a chapter's worth of pages
 * each, and nothing but the next export would have swept them. A folder some
 * tab still holds — its export running, or its download still being read — is
 * left alone. Where no export ever ran there is no folder, and none is made.
 */
export async function sweepExports (): Promise<void> {
  if (!opfsUsable()) return

  try {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle(FOLDER).catch(() => null)

    if (folder) await sweep(folder, null)
  } catch {
    // Nothing kept here is worth an error: the next export sweeps again.
  }
}

/**
 * Hold a lock named for this export, and hand back what lets it go. Resolved
 * once the lock is held, so the folder never exists unheld for a sweep to find.
 */
async function hold (name: string): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => {}

  let taken = () => {}
  let release = () => {}

  const held = new Promise<void>((resolve) => {
    taken = resolve
  })

  navigator.locks.request(LOCK + name, () => {
    taken()

    return new Promise<void>((resolve) => {
      release = resolve
    })
  }).catch(() => taken())

  await held

  return () => release()
}

/**
 * Somewhere for one export's finished pages. Never a throw: anything the disk
 * refuses is an export kept in memory instead, as every export used to be.
 */
export async function openSpill (): Promise<Spill> {
  try {
    return await open()
  } catch {
    return inMemory
  }
}

async function open (): Promise<Spill> {
  if (!opfsUsable()) return inMemory

  const root = await opfsDir(FOLDER).catch(() => null)

  if (!root) return inMemory

  // Named for when it began, so that where there are no locks a sweep can
  // still tell an abandoned folder from one that is being written.
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const release = await hold(name)

  await sweep(root, name)

  const folder = await root.getDirectoryHandle(name, { create: true }).catch(() => null)

  if (!folder) {
    release()

    return inMemory
  }

  // Once a write fails the disk is taken to be full, and the rest of the pages
  // stay in memory rather than each failing in turn.
  let full = false
  let gone = false

  const keep = async (file: string, data: Blob): Promise<Blob> => {
    if (full || gone) return data

    let writable: FileSystemWritableFileStream | null = null

    try {
      const handle = await folder.getFileHandle(file, { create: true })

      writable = await handle.createWritable()
      await writable.write(data)
      await writable.close()
      writable = null

      return await handle.getFile()
    } catch {
      await writable?.abort().catch(() => {})
      full = true

      return data
    }
  }

  const discard = async () => {
    if (gone) return

    gone = true

    await root.removeEntry(name, { recursive: true }).catch(() => {})
    release()
  }

  return {
    keep,
    discard,
    settle: () => {
      setTimeout(discard, GRACE)
    },
  }
}
