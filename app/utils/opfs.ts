/**
 * The origin's own private filesystem — where a chapter goes when the browser
 * will not let us keep hold of the folder it came from.
 *
 * This is the fallback half of opening a comic, and it is a *copy*: Firefox and
 * Safari both give us a private filesystem while refusing to hand over a handle
 * onto the user's real one, so the only way to still have the pages tomorrow is
 * to have our own. That is a genuine cost — a chapter of scans duplicated on
 * disk — and the reason the directory-handle path is preferred wherever it
 * exists rather than treated as an equal option.
 *
 * One chapter is kept per workspace, in a directory named after it. Opening
 * another chapter in the same workspace replaces what was there — which is what
 * opening another means everywhere else in the app, and what stops a session of
 * browsing through volumes from filling the disk. Two workspaces are two
 * chapters and cost two chapters' worth of room, which is the honest price of
 * having them both open.
 */

const ROOT = 'workspaces'

/**
 * Whether a chapter can be kept here at all.
 *
 * `createWritable` is checked rather than assumed: the private filesystem
 * arrived in Safari and Firefox before the plain way of writing to it did, and
 * the other way — a synchronous access handle — is only allowed inside a worker.
 * Somewhere with nowhere to write is somewhere we cannot put a chapter, and it
 * is better to know that before copying two hundred files than during.
 */
export function opfsUsable () {
  return typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function'
    && typeof FileSystemFileHandle !== 'undefined'
    && 'createWritable' in FileSystemFileHandle.prototype
}

/**
 * Ask that what we keep here is not thrown away to make room.
 *
 * Storage is evictable by default: the browser may drop it under pressure,
 * without asking and without telling. For a tool where the thing at stake is an
 * evening of cleanup work, that is worth one call to opt out of — and it is
 * only a request, so nothing depends on the answer.
 */
export async function persist () {
  try {
    await navigator.storage?.persist?.()
  } catch {
    // A browser that will not even be asked is a browser that has already said no.
  }
}

/**
 * Copy pages in, replacing whatever chapter was here.
 *
 * Paths are encoded rather than mirrored as folders. A path is one name here,
 * and `encodeURIComponent` gives it back exactly on the way out — where nesting
 * the real folders would mean creating directories on the way in and walking
 * them on the way out, for a structure nothing ever looks at.
 */
export async function copyIn (
  workspace: string,
  images: PickedImage[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  await clear(workspace)
  await addIn(workspace, images, onProgress)
}

/**
 * Put pages beside the ones already kept, rather than in place of them.
 *
 * For a chapter that arrives in instalments — the pages of a PDF, which come
 * out one at a time long after the first of them is on screen. Each is written
 * as it lands, so a tab closed halfway through leaves half a chapter that
 * opens rather than a whole one that was never saved.
 */
export async function addIn (
  workspace: string,
  images: PickedImage[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const chapter = await directory(workspace)

  let done = 0

  // One at a time, on purpose. These are whole scans, and a folder's worth of
  // them written at once is a folder's worth of them held in memory at once.
  for (const image of images) {
    const handle = await chapter.getFileHandle(encodeURIComponent(image.path), { create: true })
    const writable = await handle.createWritable()

    await writable.write(image.file)
    await writable.close()

    onProgress?.(++done, images.length)
  }
}

/**
 * One page's file, out of the chapter this browser kept.
 *
 * Only a copied chapter has anything here to remove — one held by a folder
 * handle is read from the user's own disk, and deleting a page from a workspace
 * is not permission to delete their file. Quiet when there is nothing to take
 * out, which includes both of those cases.
 */
export async function removeIn (workspace: string, path: string): Promise<void> {
  try {
    await (await directory(workspace)).removeEntry(encodeURIComponent(path))
  } catch {
    // No copy kept, or no such page in it. Either way the page is gone from
    // the chapter and this was only the file behind it.
  }
}

/** The chapter kept for a workspace, in reading order, or nothing if there is none. */
export async function readBack (workspace: string): Promise<PickedImage[]> {
  const chapter = await directory(workspace)
  const images: PickedImage[] = []

  for await (const entry of chapter.values()) {
    if (entry.kind !== 'file') continue

    const path = decodeURIComponent(entry.name)

    // Named for the page, not for the file. The copy is filed under its whole
    // path, encoded — `Chapter 12/001.jpg` as `Chapter%2012%2F001.jpg` — and
    // that is the name the file comes back with, so a chapter kept this way
    // reopened with every page called that. The file itself keeps the name it
    // is stored under: the hash memo is keyed on it, and a path is unique where
    // a bare name is not.
    images.push({ file: await entry.getFile(), path, name: path.slice(path.lastIndexOf('/') + 1) })
  }

  return inReadingOrder(images)
}

export async function clear (workspace: string) {
  try {
    const root = await workspaces()

    await root.removeEntry(workspace, { recursive: true })
  } catch {
    // Nothing to remove is the state we were asking for.
  }
}

async function directory (workspace: string) {
  // Named after the workspace rather than nested under anything of its own: an
  // id is already unique and already URL-safe, so it is a directory name as it
  // stands.
  return (await workspaces()).getDirectoryHandle(workspace, { create: true })
}

async function workspaces () {
  return opfsDir(ROOT)
}

/**
 * The app's folders in the private filesystem, each found once.
 *
 * Every store here — the chapters, the thumbnails, the repairs, the placed
 * images, the models — lives in a folder at the top, and each used to be found
 * again on every read and every write: the root, then the folder, two trips
 * through the storage queue before the one that did anything. A chapter
 * restoring its cleaning reads hundreds of repairs, sixteen at a time, behind
 * a segmenter that is also using the disk, and half of that queue was this.
 *
 * Only the folders at the top are kept, never anything inside them: a
 * workspace's folder is deleted whole by `clear` and made again by `copyIn`,
 * and a handle kept on it would be a handle on nothing. A lookup that fails is
 * forgotten, so a browser that refuses once — a private window — is asked
 * again rather than refused for good.
 */
const folders = new Map<string, Promise<FileSystemDirectoryHandle>>()

export function opfsDir (name: string): Promise<FileSystemDirectoryHandle> {
  let found = folders.get(name)

  if (!found) {
    found = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(name, { create: true }))
    found.catch(() => { folders.delete(name) })
    folders.set(name, found)
  }

  return found
}

/**
 * A file out of one of the app's folders, or null — and never a throw.
 *
 * What every store's `read…` is. A missing file, a browser with no private
 * filesystem and one that refuses are all the same answer to the caller: not
 * here, so make it again or do without.
 */
export async function opfsRead (folder: string, name: string): Promise<File | null> {
  if (!opfsUsable()) return null

  const dir = await opfsDir(folder).catch(() => null)

  return dir?.getFileHandle(name).then((handle) => handle.getFile()).catch(() => null) ?? null
}

/**
 * Write a file into one of the app's folders, and say whether it went.
 *
 * Never a throw, like reading: everything kept here is kept so that something
 * is cheaper next time, and a write that fails costs that and nothing else.
 * Tried a second time with the folder looked up afresh, in case the one held
 * was deleted underneath this tab — site data cleared while it was open.
 */
export async function opfsWrite (folder: string, name: string, bytes: Blob): Promise<boolean> {
  if (!opfsUsable()) return false

  for (let tries = 0; tries < 2; tries++) {
    try {
      const handle = await (await opfsDir(folder)).getFileHandle(name, { create: true })
      const writable = await handle.createWritable()

      await writable.write(bytes)
      await writable.close()

      return true
    } catch {
      folders.delete(folder)
    }
  }

  return false
}

/** Every file's name in one of the app's folders, or none. */
export async function opfsNames (folder: string): Promise<string[]> {
  if (!opfsUsable()) return []

  const dir = await opfsDir(folder).catch(() => null)
  const names: string[] = []

  if (!dir) return names

  try {
    for await (const entry of dir.values()) if (entry.kind === 'file') names.push(entry.name)
  } catch {
    // A listing that fails is a listing of nothing, for every caller here.
  }

  return names
}

/** Where a build that had no workspaces kept its one and only chapter. */
const LEGACY = 'chapter'

/**
 * Hand the old single chapter over to the workspace now asking for one.
 *
 * Only ever true once, on the first visit after workspaces existed, and the old
 * directory is gone by the end of it. Delete this — and the caller in
 * `useLibrary` — once nobody can still be arriving from a build that had it.
 */
export async function adoptLegacy (workspace: string): Promise<void> {
  const root = await navigator.storage.getDirectory()

  const legacy = await root.getDirectoryHandle(LEGACY).catch(() => null)

  if (!legacy) return

  const images: PickedImage[] = []

  for await (const entry of legacy.values()) {
    if (entry.kind !== 'file') continue

    images.push({ file: await (entry as FileSystemFileHandle).getFile(), path: decodeURIComponent(entry.name) })
  }

  if (images.length) await copyIn(workspace, inReadingOrder(images))

  await root.removeEntry(LEGACY, { recursive: true }).catch(() => {})
}
