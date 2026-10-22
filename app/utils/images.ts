/**
 * Images off the machine the browser is running on, and nowhere else.
 *
 * Nothing here reads bytes or sends them anywhere: a dropped file is handed on
 * as the `File` the browser already has, and it is the caller that decides what
 * to do with it. That is the whole point — the pages of a comic being worked on
 * are the user's scans, and they should not have to leave the room to be looked
 * at.
 *
 * The one exception is a PDF, which is read — here, on this machine — because
 * a PDF of scans is a stack of images in a wrapper, and the images are what
 * was meant by dropping it. See `pdf/extract.ts`, which lifts them out whole
 * rather than rendering them: original bytes for JPEGs, lossless PNG for the
 * rest.
 *
 * There are two ways in and they are not equal. Where the browser will give up a
 * *handle* on the folder, that handle is the prize: it can be kept, and a kept
 * handle means opening the same chapter tomorrow without asking the user to find
 * it again, and one day writing the finished plates back where the raws are.
 * Where it will not — Firefox and Safari give a private filesystem but no handle
 * on a real one — all that comes back is the files themselves, and keeping them
 * means copying them. So everything here reports which of the two it got, and
 * lets the caller pay the difference.
 */

import { crc32 } from './crc32'
import { PdfPasswordError } from './pdf/decrypt'
import { pdfPages } from './pdf/pages'
import { askForPassword } from './pdf/password'

import type { FolderTally } from '~/composables/useFolderCheck'

/** What the canvas can draw. Anything else in a dropped folder is not a page. */
const IMAGE = /\.(?:avif|bmp|gif|jfif|jpe|jpe?g|png|webp)$/i

/** Not a page itself, but a book of them — opened out by `unpacked` below. */
const PDF = /\.pdf$/i

/**
 * Whether a file is a page.
 *
 * The name is only half of it. Real chapters come with `.jfif` off an old
 * scanner, with the extension stripped by whatever unpacked them, or in caps —
 * and the browser has already worked out what the thing actually is, so its
 * answer counts for as much as the name does. Either will do; a folder that
 * silently opened as empty because of a spelling is the failure to avoid.
 */
function isPage (file: File) {
  return IMAGE.test(file.name) || file.type.startsWith('image/')
}

function isPdf (file: File) {
  return PDF.test(file.name) || file.type === 'application/pdf'
}

/** Anything worth taking off a drop or out of a folder: a page, or a book of them. */
function isOpenable (file: File) {
  return isPage(file) || isPdf(file)
}

/** The extensions we say we take, for when a folder turns out to have none. */
export const IMAGE_KINDS = 'jpg, png, webp, gif, avif, bmp or pdf'

export interface PickedImage {
  file: File
  /**
   * Where it sat under whatever was dropped, folders and all — which is what
   * puts the pages in order. A file's own name is not enough: two chapters of a
   * volume both start at `001`.
   */
  path: string
  /**
   * What the page is called, where the file's own name is not it — see
   * `readBack`, whose files are named for where they are kept. Absent almost
   * everywhere, and then the file's name is the page's. Read through
   * `pickedName`.
   */
  name?: string
}

/** What a page opened from this image is called — see `PickedImage.name`. */
export const pickedName = (image: PickedImage) => image.name ?? image.file.name

/**
 * Pages still coming out of a PDF after the ones already handed over.
 *
 * The point of the arrangement: opening a book yields its first page almost
 * at once and leaves the rest arriving in the background, so the canvas has
 * something on it while the reading goes on. Draining this is the caller's
 * job — see `useLibrary`, which appends each page to the open comic and puts
 * it in storage as it lands.
 */
export interface Rest {
  /** Each page, how far through its own book it is, and which book that is. */
  pages: AsyncGenerator<{ image: PickedImage, done: number, total: number, of: string }>
  /** How many images the book being read holds, for something to count towards. */
  expected: number
  /** What is being read, to say so. */
  of: string
}

/** Pages to hand over now, and pages still on their way. */
export interface Found {
  images: PickedImage[]
  rest: Rest | null
}

/**
 * What opening a folder got us: a handle on it if the browser gave one, and the
 * pages either way.
 *
 * Both, rather than one or the other, because the pages are wanted now and the
 * handle is only wanted later — there is no sense reading the folder twice.
 */
export interface Opened extends Found {
  /** The folder itself, where the browser will part with it. */
  handle: FileSystemDirectoryHandle | null
  /** What to call the comic: the folder's name, where there was a folder. */
  title: string | null
  /**
   * Desktop: every file and folder the pages came out of, where the browser
   * handed over a handle on each — see `Source`. Absent where it would not,
   * and the chapter is then kept as a copy, as it always was.
   */
  sources?: Source[]
}

/**
 * Desktop: one thing the reader dropped or picked, kept so the chapter can be
 * read out of it again — the reader's own file or folder, where it is.
 *
 * In a browser a dropped file is gone when the tab closes, so the web build
 * copies loose pages into the private filesystem to have them tomorrow. Here a
 * drop or a pick hands over a handle on each thing, and the app's own origin is
 * allowed to read through one again after a restart (`keepFolderAccess` in
 * `electron/main.ts`). So a chapter of loose files is kept the way a folder is:
 * as what it was opened from, not as a second copy of every page on the disk.
 *
 * Each carries the path its pages were filed under when they arrived, because a
 * page's id is `scan:<path>` and the chapter's order, names and history hang
 * off it: read again, a file must come back as the same page. A file's `path`
 * is that page's (or, for a PDF, the folder its pages are filed under); a
 * folder's `prefix` is put before every path found in it.
 */
export type Source =
  | { kind: 'file', handle: FileSystemFileHandle, path: string }
  | { kind: 'folder', handle: FileSystemDirectoryHandle, prefix: string }

/**
 * Desktop: the pages of a chapter kept as its sources, read out of them again —
 * PDFs opened out as a drop opens them, and the lot in reading order. A source
 * that has been moved or deleted since is counted in `missing` and skipped:
 * one file gone is one page gone, not a chapter.
 */
export async function imagesOf (sources: Source[], { reopening = false }: { reopening?: boolean } = {}): Promise<Found & { missing: number }> {
  const found: PickedImage[] = []
  let missing = 0

  for (const source of sources) {
    try {
      if (source.kind === 'file') {
        const file = await source.handle.getFile()

        if (isOpenable(file)) found.push({ file, path: source.path })
      } else {
        const before = found.length

        await descend(source.handle, source.prefix, found)

        if (found.length === before) missing++
      }
    } catch {
      missing++
    }
  }

  const opened = await unpacked(found, reopening)

  return { ...opened, images: inReadingOrder(opened.images), missing }
}

/**
 * Desktop: the handle behind each thing in a drop, as a `Source` filed under the
 * path the drop gave its pages — or nothing, where any one of them came without
 * a handle, since a chapter half kept by reference and half not would come back
 * half there.
 */
async function sourcesOf (items: { entry: FileSystemEntry | null, handle: Promise<FileSystemHandle | null> | null }[]): Promise<Source[] | undefined> {
  const sources: Source[] = []

  for (const { entry, handle } of items) {
    const held = await handle?.catch(() => null)

    if (!held || !entry) return undefined

    // The path the drop filed it under — `walk` takes the same `fullPath`.
    const path = entry.fullPath.replace(/^\//, '')

    sources.push(held.kind === 'file'
      ? { kind: 'file', handle: held as FileSystemFileHandle, path }
      : { kind: 'folder', handle: held as FileSystemDirectoryHandle, prefix: `${path}/` })
  }

  return sources
}

/**
 * `10` after `9`, not between `1` and `2`. Scans are numbered, rarely padded,
 * and a plain sort puts the tenth page of a chapter in the middle of the first.
 */
const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * A shape somebody painted, in the scan's own pixels: where the brush went and
 * how wide it was.
 *
 * Flat pairs rather than points, because that is what every stroke in this app
 * already is — see `MaskEdit.points` and `StrokeDraft.points` — and a region
 * drawn with the brush is one more of them. The radius is half the diameter the
 * ring showed, so the shape is as wide as what was aimed with rather than as
 * wide as the line through its middle.
 */
export interface CropShape {
  path: number[]
  radius: number
}

/**
 * Everything the brush did not go over, taken back to white.
 *
 * A region painted rather than dragged is a shape, and that is the whole reason
 * to paint it: lettering laid across artwork, running around a figure or
 * squeezed between two balloons brings its neighbours inside its own bounding
 * box, and a reader handed that rectangle reads them too. Knocking them out
 * leaves exactly one thing in the picture, which is the same trick `cropOut`
 * plays on the page as a whole and the reason it works.
 *
 * White, behind, rather than transparent: alpha means nothing to a model that
 * has already flattened the crop onto black, and black around glyphs is a page
 * inverted — which every recogniser here reads worse than it reads nothing.
 * `destination-over` fills only what the knockout emptied, so the artwork
 * inside the shape is never painted over.
 *
 * The shape is grown by the crop's own margin, for the reason the crop has one:
 * a stroke is aimed at the ink, and what hangs outside the ink — a tail, a
 * diacritic, the overshoot of a brush character — is exactly what tells one
 * character from another. Painting tight to a glyph should not cost its
 * strokes.
 */
function knockOut (
  context: OffscreenCanvasRenderingContext2D,
  shape: CropShape,
  x: number,
  y: number,
  w: number,
  h: number,
  pad: number,
) {
  context.globalCompositeOperation = 'destination-in'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, (shape.radius + pad) * 2)
  context.strokeStyle = '#000'

  context.beginPath()
  context.moveTo(shape.path[0]! - x, shape.path[1]! - y)

  for (let i = 2; i < shape.path.length - 1; i += 2) {
    context.lineTo(shape.path[i]! - x, shape.path[i + 1]! - y)
  }

  // A dab, for a press that never travelled. A subpath of no length strokes
  // nothing in some engines however round the cap is, so it is given one.
  if (shape.path.length === 2) context.lineTo(shape.path[0]! - x + 0.01, shape.path[1]! - y)

  context.stroke()

  context.globalCompositeOperation = 'destination-over'
  context.fillStyle = '#fff'
  context.fillRect(0, 0, w, h)

  context.globalCompositeOperation = 'source-over'
}

/**
 * One rectangle of a scan, as an image in its own right.
 *
 * For handing a single balloon to a reader — see `useOcr.readBlock`. The
 * alternative was to pass the box alongside the page, and it does not work:
 * some readers take regions and some find their own, so a self-detecting one
 * asked about a balloon returns the whole page with no way to say which answer
 * was wanted. A picture of one balloon has exactly one answer in it.
 *
 * The margin is a fraction of the shorter side rather than a fixed number of
 * pixels, because a box is tight to the glyphs and their strokes hang outside
 * it — and a fixed margin is either nothing on a full-page caption or the whole
 * balloon on a small one. Eight per cent is what `manga.ts` pads its own
 * regions by, arrived at there for the same reason.
 *
 * PNG rather than JPEG: this is going to an OCR model, and JPEG's ringing
 * around high-contrast edges is precisely the artefact that turns one character
 * into another. It costs bytes that never leave the machine.
 *
 * A `shape` narrows the crop from the rectangle to what was actually painted —
 * see `knockOut`. The box still governs how much page is cut out and how much
 * margin it gets; the shape only decides what inside it survives.
 */
export async function cropOut (
  file: Blob,
  box: { x: number, y: number, w: number, h: number },
  margin = 0.08,
  shape?: CropShape | null,
): Promise<{ file: Blob, width: number, height: number } | null> {
  const bitmap = await createImageBitmap(file)

  try {
    const pad = Math.round(Math.min(box.w, box.h) * margin)

    const x = Math.max(0, Math.round(box.x) - pad)
    const y = Math.max(0, Math.round(box.y) - pad)
    const w = Math.min(bitmap.width - x, Math.round(box.w) + pad * 2)
    const h = Math.min(bitmap.height - y, Math.round(box.h) + pad * 2)

    // A box dragged off the edge of the page, or one collapsed to nothing.
    if (w < 4 || h < 4) return null

    const canvas = new OffscreenCanvas(w, h)
    const context = canvas.getContext('2d')

    if (!context) return null

    context.drawImage(bitmap, x, y, w, h, 0, 0, w, h)

    if (shape?.path.length) knockOut(context, shape, x, y, w, h, pad)

    return { file: await canvas.convertToBlob({ type: 'image/png' }), width: w, height: h }
  } finally {
    // The decoded page in memory, which is the whole scan rather than the crop.
    bitmap.close()
  }
}

/** By path rather than by name: two chapters of a volume both start at `001`. */
export function inReadingOrder (images: PickedImage[]) {
  return [...images].sort((a, b) => order.compare(a.path, b.path))
}

/**
 * The same ordering, for things that are not files — page ids, which carry
 * the path they were made from. Pages arriving one at a time have to be put
 * where they belong, and they belong where their paths say.
 */
export function comparePaths (a: string, b: string) {
  return order.compare(a, b)
}

/**
 * One PNG chunk: its length, its type, its data, and the CRC over both of the
 * last two — the reflected polynomial zlib uses, from `utils/crc32.ts`, which
 * every writer in the app shares.
 */
function pngChunk (type: string, data: Uint8Array) {
  const named = new Uint8Array(4 + data.length)

  named.set(new TextEncoder().encode(type))
  named.set(data, 4)

  const chunk = new Uint8Array(8 + data.length + 4)
  const view = new DataView(chunk.buffer)

  view.setUint32(0, data.length)
  chunk.set(named, 4)
  view.setUint32(8 + data.length, crc32(named))

  return chunk
}

/**
 * Where `IEND` starts, which is where anything more to say has to be said.
 *
 * PNG is a stream of chunks and `IEND` closes it — bytes after it are not read
 * by anything. Walked rather than assumed to be the last twelve bytes, because
 * a file that is not a PNG at all should come back as one we leave alone rather
 * than one we splice blindly.
 */
function endOfPng (bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

  if (bytes.length < 12 || signature.some((byte, at) => bytes[at] !== byte)) return -1

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let at = 8

  while (at + 12 <= bytes.length) {
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)

    if (type === 'IEND') return at

    at += 12 + view.getUint32(at)
  }

  return -1
}

/**
 * A blank page's own path, written into the file where it changes the bytes
 * and not the picture.
 *
 * Every white page of a given size is otherwise the same PNG down to the byte,
 * and a page's SHA-256 is its identity throughout this app: the block cache is
 * keyed by it, so is the thumbnail, so is every cleaned patch, and it is what
 * a peer asks the swarm for. Two blanks that hash alike therefore share one
 * entry in each of those — letter one and the other comes back wearing its
 * lettering after a reload.
 *
 * Metadata rather than a pixel nudged off white, and the reason is not
 * squeamishness about the art. The hash has to remain a *true* content hash:
 * pages travel by hash and are re-hashed on arrival, so nothing may be
 * synthesised into the digest that is not really in the file. A name is really
 * in the file. It is also the honest answer to "why are these two different?".
 *
 * `iTXt` rather than the older `tEXt` because `tEXt` is Latin-1 and these paths
 * carry whatever the chapter's folder was called — a page of `ECLIPSE日蚀2` has
 * no Latin-1 spelling. Uncompressed, with no language tag and no translated
 * keyword, which is the shortest conforming form.
 */
function stamped (bytes: Uint8Array<ArrayBuffer>, path: string) {
  const end = endOfPng(bytes)

  // Not a PNG we recognise. Handing back what we were given loses the blanks'
  // distinctness, which is worth less than handing back something malformed.
  if (end === -1) return bytes

  const keyword = new TextEncoder().encode('kemolate:path')
  const text = new TextEncoder().encode(path)

  const data = new Uint8Array([
    ...keyword, 0, // the keyword, terminated
    0, 0, //          uncompressed, and so no compression method
    0, //             no language tag
    0, //             no translated keyword
    ...text,
  ])

  const chunk = pngChunk('iTXt', data)
  const out = new Uint8Array(bytes.length + chunk.length)

  out.set(bytes.subarray(0, end))
  out.set(chunk, end)
  out.set(bytes.subarray(end), end + chunk.length)

  return out
}

/**
 * A white page made here rather than opened from anywhere — what adding a
 * blank page inserts.
 *
 * A real PNG rather than a scanless record, because everything downstream —
 * painting, reading, keeping, handing to a peer — works on a file, and a page
 * without one is drawn as absent on purpose.
 *
 * Its path goes into the file itself, not only onto the `File` around it: see
 * `stamped` for the collision that names alone do not prevent.
 */
export async function blankImage (path: string, width: number, height: number): Promise<PickedImage | null> {
  const canvas = document.createElement('canvas')

  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')

  if (!context) return null

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

  if (!blob) return null

  const name = path.slice(path.lastIndexOf('/') + 1)
  const bytes = stamped(new Uint8Array(await blob.arrayBuffer()), path)

  return { file: new File([bytes], name, { type: 'image/png' }), path }
}

/** Whether this browser will let a folder be chosen as a folder. */
export function canPickFolder () {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * The images in a drop, in reading order, however deep in folders they were —
 * and the folder itself, on a browser that will hand it over.
 *
 * Must be called from the drop handler itself and before anything is awaited:
 * a `DataTransfer` is emptied the moment that handler returns, so everything is
 * taken off it up front and only then looked at.
 */
export async function imagesFrom (transfer: DataTransfer): Promise<Opened> {
  const items = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => ({
      entry: item.webkitGetAsEntry(),
      // Chromium hands over a real handle here, which is worth far more than
      // the entry beside it. Asked for now and looked at later, because asking
      // is synchronous and the answer is not.
      handle: item.getAsFileSystemHandle?.() ?? null,
    }))

  // A single folder is a chapter, and the one case where a kept handle means
  // anything — a handful of loose files has no folder to come back to.
  if (items.length === 1 && items[0]!.handle) {
    // A browser that will not give a handle says so by giving nothing, which is
    // not a failure — there is a whole other way in below. Anything else it has
    // to say is worth hearing rather than swallowing.
    const handle = await items[0]!.handle.catch(() => null)

    if (handle?.kind === 'directory') {
      const folder = handle as FileSystemDirectoryHandle

      const found = await imagesIn(folder).catch((): Found => ({ images: [], rest: null }))

      if (found.images.length) return { ...found, handle: folder, title: folder.name }

      /*
       * A handle that reads as nothing is not the end of the drop.
       *
       * It used to be: the handle went back with no pages, and the caller
       * turned it into a "Reopen folder" offer, on the reasoning that a click
       * can ask for the read permission a drop cannot. Where the browser will
       * never ask — the Claude desktop app's built-in browser is one — that
       * offer led nowhere: "Nothing could be read", then "That folder can't be
       * reopened", and the pages the reader had just dragged in were never
       * looked at, although the drop was carrying every one of them.
       *
       * The entries walked below need no permission, so the same drop is read
       * that way instead, and the chapter is kept as a copy — which is what a
       * browser that will not keep a folder gets anyway. The folder on disk is
       * not touched either way.
       */
    }
  }

  const entries = items
    .map((item) => item.entry)
    .filter((entry): entry is FileSystemEntry => Boolean(entry))

  const found: PickedImage[] = []

  // No entries means no tree to walk — a plain list of files still drops fine,
  // and this is what makes the drop work where the entries API does not.
  if (!entries.length) {
    for (const file of transfer.files) {
      if (isOpenable(file)) found.push({ file, path: file.name })
    }
  } else {
    await Promise.all(entries.map((entry) => walk(entry, found)))
  }

  const opened = await unpacked(found)
  const images = inReadingOrder(opened.images)

  // Desktop: kept by reference where every item came with a handle — except a
  // lone folder whose handle read as nothing above, which would read as nothing
  // again tomorrow and so is kept as a copy, as the note there says.
  const lone = items.length === 1 && (await items[0]!.handle?.catch(() => null))?.kind === 'directory'
  const sources = lone ? undefined : await sourcesOf(items)

  return { ...opened, handle: null, images, title: rootOf(images), sources }
}

/**
 * The folder the user chooses, by whichever means this browser has.
 *
 * The picker is tried first and the input is the fallback, which is the whole
 * shape of this feature in one function: the same gesture gets a folder we can
 * keep on Chromium and a pile of files everywhere else.
 */
export async function pickFolder ({ check }: { check?: FolderAsk } = {}): Promise<Opened> {
  const picker = window.showDirectoryPicker

  if (picker) {
    // Read for now. Writing the finished plates back is what this handle is
    // really for, but asking to edit a folder we have not yet written a byte to
    // is asking for more than we use — the upgrade is its own prompt, when
    // there is finally something to save.
    //
    // Only a dismissed dialog is caught here. Everything else the picker can
    // throw — a blocked gesture, a folder the browser refuses to open — is a
    // thing the user needs told, and catching it all was how those became a
    // button that silently did nothing.
    const handle = await picker.call(window, { mode: 'read' }).catch((error: unknown) => {
      // Chrome says `AbortError` both for a dialog the user dismissed and for a
      // folder it refuses to hand over at all — the Desktop, Documents, a home
      // directory. Only the first deserves silence, and there is no way to tell
      // them apart from here, so the second at least leaves a trace.
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.debug('[kemolate] folder picker dismissed, or the folder was blocked:', error.message)

        return null
      }

      throw error
    })

    // Nothing chosen. Not a failure, and not a reason to close what is open.
    if (!handle) return { handle: null, images: [], rest: null, title: null }

    let declined = false

    const found = await imagesIn(handle, {
      check: check && (async (counted) => {
        const yes = await check({ ...counted, name: handle.name })

        declined = !yes

        return yes
      }),
    })

    // Desktop: declined at `check`, which is nothing chosen.
    if (declined) return { handle: null, images: [], rest: null, title: null }

    return { ...found, handle, title: handle.name }
  }

  const found = await pickImages({ folder: true, check })

  return { ...found, handle: null, title: rootOf(found.images) }
}

/**
 * One image, chosen from the file dialog, or nothing if the dialog was closed.
 *
 * Deliberately not `pickImages` with a count of one. That one opens a comic —
 * it unpacks PDFs, sorts what it finds into reading order, and answers in
 * `PickedImage`s with paths, because what it is being asked for is a chapter.
 * This is being asked for a file: a clean of a page that already exists. Sorting
 * one image is nothing, a PDF is not an answer to it, and a path is a name for a
 * page rather than for a picture of one.
 */
export function pickImage (): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')

    input.type = 'file'
    input.accept = 'image/*'

    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))

    input.click()
  })
}

/**
 * The images the user chooses from the file dialog.
 *
 * The input is never put in the page. It does not need to be to be clicked, and
 * one that is has to be found somewhere to live and cleared before it will fire
 * twice for the same folder.
 */
export async function pickImages ({ folder = false, check }: { folder?: boolean, check?: FolderAsk } = {}): Promise<Found & { sources?: Source[] }> {
  // Desktop: files through the file picker where there is one, because it hands
  // over a handle on each — which is what lets the chapter be read from them
  // again rather than copied (see `Source`). A dismissed dialog is nothing chosen.
  const picker = typeof window === 'undefined' ? undefined : window.showOpenFilePicker

  if (!folder && picker) {
    const handles = await picker.call(window, {
      multiple: true,
      types: [{ description: 'Pages', accept: { 'image/*': [], 'application/pdf': ['.pdf'] } }],
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return []

      throw error
    })

    const sources: Source[] = handles.map((handle) => ({ kind: 'file', handle, path: handle.name }))
    const found = await imagesOf(sources)

    return { images: found.images, rest: found.rest, sources: sources.length ? sources : undefined }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input')

    input.type = 'file'
    input.accept = 'image/*,application/pdf,.pdf'

    if (folder) input.webkitdirectory = true
    else input.multiple = true

    input.addEventListener('cancel', () => resolve({ images: [], rest: null }))
    input.addEventListener('change', () => {
      const files = [...input.files ?? []]
        .filter(isOpenable)
        // `webkitRelativePath` is the folder path when there was a folder, and
        // an empty string when there was not.
        .map((file) => ({ file, path: file.webkitRelativePath || file.name }))

      // Desktop: a folder past `useFolderCheck`'s marks is asked about first.
      const go = folder && check && files.length
        ? check({ ...tally(files), name: rootOf(files) })
        : Promise.resolve(true)

      // Rejection travels: a PDF that turns out to be locked is a reason the
      // caller has a toast for, not a silent empty pick.
      go.then((yes): Promise<Found> | Found => yes ? unpacked(files) : { images: [], rest: null }).then(
        (found) => resolve({ ...found, images: inReadingOrder(found.images) }),
        reject,
      )
    })

    input.click()
  })
}

/**
 * Every image under a folder handle, in reading order.
 *
 * It reads. It does not ask first, and that is deliberate: a folder that has
 * just been dropped or just been chosen is already ours to read, and a `drop`
 * is not one of the events that grants the activation `requestPermission` needs
 * — so asking there cannot succeed and refusing to read without asking turns a
 * working folder into a permission error. Asking belongs where there is a click
 * to do it with, which is `reopen` in `useLibrary`.
 *
 * `reopening` is the kept folder of a chapter coming back, rather than a folder
 * just chosen: any PDF in it was opened here before, and its pages must come
 * out as the same files they came out as then — see `pdf/identity.ts`.
 */
export async function imagesIn (handle: FileSystemDirectoryHandle, { reopening = false, check }: { reopening?: boolean, check?: (counted: Omit<FolderTally, 'name'>) => Promise<boolean> } = {}): Promise<Found> {
  const found: PickedImage[] = []

  await descend(handle, '', found)

  // Desktop: counted, then asked about, before any PDF in it is opened — the
  // listing is cheap and the books are not. See `useFolderCheck`.
  if (check && found.length && !await check(tally(found))) return { images: [], rest: null }

  const opened = await unpacked(found, reopening)

  return { ...opened, images: inReadingOrder(opened.images) }
}

/** Desktop: a folder's say before it is read — see `useFolderCheck`. */
type FolderAsk = (tally: FolderTally) => Promise<boolean>

/** Desktop: what `useFolderCheck` counts. */
function tally (images: PickedImage[]) {
  return { files: images.length, pdfs: images.filter((image) => isPdf(image.file)).length }
}

async function descend (handle: FileSystemDirectoryHandle, prefix: string, into: PickedImage[]) {
  // One unreadable thing in a folder is one unreadable thing, not a failed
  // chapter. A real folder has junk in it — a subfolder the browser will not
  // open, a file the operating system keeps to itself — and none of that is a
  // reason to hand back nothing. The listing itself is inside this too: an
  // iterator that gives up part way should still leave us the pages it did give.
  try {
    for await (const entry of handle.values()) {
      const path = prefix + entry.name

      if (entry.kind === 'directory') {
        await descend(entry as FileSystemDirectoryHandle, `${path}/`, into)

        continue
      }

      try {
        // Asked for before it is judged, rather than after: turning a handle
        // into a `File` reads nothing off the disk, and it is what lets a page
        // with the wrong name still be recognised as one.
        const file = await (entry as FileSystemFileHandle).getFile()

        if (isOpenable(file)) into.push({ file, path })
      } catch {
        // A page that has gone since the folder was listed. Skipped.
      }
    }
  } catch (error) {
    // Nothing at all read means nothing at all to show, and the reason is worth
    // carrying up. Anything already found is a partial folder, which is better
    // than an error about one.
    if (!into.length) throw error
  }
}

/**
 * PDFs among what was picked, opened out into the pages inside them.
 *
 * Each becomes the images it contains, under its own name as a folder —
 * `chapter.pdf/001.jpg` — so a PDF beside loose pages sorts as the chapter it
 * is. One PDF that will not open is skipped the way one unreadable file in a
 * folder is; but when it was the *only* thing there, its reason is the whole
 * story and is thrown for the caller's toast to tell, because "no pages
 * found" about a password-locked file is a lie.
 *
 * Only far enough to have something to show. A book is opened, its first page
 * is waited for, and the rest is left running as `rest` for the caller to
 * drain — which is what lets a two-hundred page PDF be read *while* page one
 * is on screen instead of before it.
 */
async function unpacked (images: PickedImage[], reopening = false): Promise<Found> {
  const books = images.filter((image) => isPdf(image.file))

  if (!books.length) return { images, rest: null }

  const loose = images.filter((image) => !isPdf(image.file))
  const stream = pagesOf(books, reopening)
  const first = await stream.next()

  // Every book failed, and `pagesOf` has already thrown if that was all there
  // was. Nothing more is coming, so there is no stream to hand on.
  if (first.done) return { images: loose, rest: null }

  return {
    images: [...loose, first.value.image],
    rest: { pages: stream, expected: first.value.total, of: first.value.of },
  }
}

/**
 * Every book's pages, one after another, as one stream.
 *
 * Books are read in turn rather than at once. Two workers inflating two
 * chapters race each other for the same cores and both finish later than
 * either would alone, and the pages of the first book are the ones somebody
 * is actually looking at.
 */
async function * pagesOf (books: PickedImage[], reopening: boolean): AsyncGenerator<{ image: PickedImage, done: number, total: number, of: string }> {
  let out = 0
  let reason: unknown = null

  for (const book of books) {
    // Nothing to begin with, which is also how a locked book gets its free
    // first go: the empty password opens every PDF that was only ever
    // restricted rather than sealed, and those must not raise a prompt.
    let password: string | undefined
    let sent = 0

    for (;;) {
      try {
        for await (const arrival of pdfPages(book.file, book.path, { password, reopening })) {
          out++
          sent++

          // Named per arrival rather than once for the lot: a folder with two
          // books in it is read one after the other, and a progress line still
          // naming the first while the second is being read is a wrong label.
          yield { ...arrival, of: book.file.name }
        }

        break
      } catch (error) {
        // Locked, and nothing of it has been handed over yet — so asking and
        // starting again costs nothing and duplicates nothing. A book that has
        // already given up pages cannot be restarted this way, and a password
        // is never wanted that late in any case.
        if (error instanceof PdfPasswordError && !sent) {
          const said = await askForPassword(book.file.name, error.wrong)

          if (said !== null) {
            password = said

            continue
          }
        }

        console.warn(`[kemolate] the pages of “${book.path}” could not be read`, error)
        reason ??= error

        break
      }
    }
  }

  // Nothing came out of any of them, and the first reason is as good an answer
  // as there is. Thrown rather than returned, so a locked PDF says so instead
  // of looking like an empty folder.
  if (!out && reason) throw reason
}

/**
 * The folder these came out of, where they all came out of one — which is what
 * the user calls this comic, and better than anything we would make up.
 */
function rootOf (images: PickedImage[]) {
  const [first] = images

  if (!first?.path.includes('/')) return null

  return first.path.split('/')[0] ?? null
}

/** One entry, and everything under it if it turns out to be a folder. */
async function walk (entry: FileSystemEntry, into: PickedImage[]): Promise<void> {
  if (entry.isFile) {
    const file = await toFile(entry as FileSystemFileEntry)

    // `fullPath` is relative to the drop, and leads with a slash it does not
    // need — it is a path *within* what was dropped, not an absolute one.
    if (file && isOpenable(file)) into.push({ file, path: entry.fullPath.replace(/^\//, '') })

    return
  }

  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()

  // A reader hands back a batch at a time and an empty batch to mean there are
  // no more. One call is not the folder — asking once is how a hundred-page
  // chapter opens as its first hundred files or fewer.
  for (;;) {
    const batch = await readBatch(reader)

    if (!batch.length) break

    await Promise.all(batch.map((child) => walk(child, into)))
  }
}

/**
 * A file that has since been moved or deleted still has an entry, and asking
 * for it fails rather than returning nothing — which is a page missing from a
 * chapter, not a reason to drop the other two hundred.
 */
function toFile (entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)))
}

function readBatch (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
}
