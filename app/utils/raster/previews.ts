/**
 * Every page of a chapter, kept on disk at the size it is shown at, so that
 * turning to any page decodes a small file instead of the scan.
 *
 * The scans that prompted it are 3732 × 5197 JPEGs of up to 25 MB, and a page
 * nobody has turned to yet cost 125–230 ms of decoding before it could be
 * drawn. Held in memory for a whole chapter they would be 16 MB a page at the
 * size they are shown — some 700 MB for one book — so the pages around the one
 * on screen are held in memory (`Engine.vue`) and every other page is kept
 * here, as a lossless WebP of the page at its fitted size. Measured on those
 * pages: exact, 2.4–3 MB, and 33–41 ms to decode.
 *
 * Beside `thumbs/`, and on the same terms: filed under the scan's own hash, so
 * the same page found again anywhere is the same file; derived, so it is never
 * in a project file; and a display copy only — zooming in still draws from the
 * scan itself, so nothing here stands in for a source page.
 *
 * Unlike a thumbnail it goes when its workspace does, because it is forty times
 * the size — 100 MB for a chapter of large pages. Being filed under the scan
 * is what makes that a question rather than a prefix: two workspaces can hold
 * the same page, and deleting one must not take the other's. So each
 * workspace records which scans it makes previews for (`previews:<id>`, owned
 * by the workspace and deleted with it), and deleting one keeps every preview
 * some other workspace still names (`sweepPreviews`).
 *
 * Named by height, in steps of 128, so a window resized a little finds the
 * previews it made before; a preview is drawn at the exact fit from the step
 * at or above it. One per page: making one at a new size removes the page's
 * others, so a window resized often cannot fill the disk with old sizes.
 */

import { idb } from '../idb'
import { idbKey } from '../idbKeys'
import { opfsDir, opfsNames, opfsRead, opfsWrite } from '../opfs'
import { backgroundDecoders } from '../resources'

import { jobKey, scanJob, scanPreview } from './decoder'

import type { Over } from './engine/overs'
import type { Size } from './plan'

const ROOT = 'previews'

/**
 * Heights previews are made at, so a small change of window does not make a
 * new set. Not coarser: a preview is drawn down to the fit from the step above
 * it, and at 512 that was up to 40% more pixels than shown — measured at 1 to
 * 8.7 MB a page, against 2.4–3 MB for previews made at the fit itself.
 */
const STEP = 128

/** The preview size for a fit level: the step at or above its height, never past the scan itself. */
export function previewSize (page: Size, fit: Size): Size {
  const height = Math.min(page.height, Math.ceil(fit.height / STEP) * STEP)

  return { width: Math.max(1, Math.round(page.width * (height / page.height))), height }
}

export const previewName = (hash: string, size: Size) => `${hash}@${size.height}.webp`

/** The kept preview of a page at this size, or null. */
export function readPreview (hash: string, size: Size): Promise<File | null> {
  return opfsRead(ROOT, previewName(hash, size))
}

/*
 * A page's cleaning, beside its preview: every repair on the page drawn into
 * one transparent picture at the preview's size.
 *
 * A page is shown only once its scan *and* every repair it has are decoded —
 * the printed lettering is never shown on its own on the way — and a page of
 * istani has five to thirteen repairs, each a file of its own to fetch, decode
 * and upload. Turning faster than that showed each page grey until they were
 * all in. With this a page is two decodes, the scan's preview and its
 * cleaning, whatever it has on it; the repairs themselves still arrive after,
 * and take over once they are all in, because they are sharp at any zoom and
 * this is only sharp at the size it was made for.
 *
 * Kept apart from the scan's preview rather than baked into it, because the
 * two are separate layers: the Read preset hides the cleaning, and the Clean
 * plate has its own opacity and adjustments. A picture of both at once would
 * be right for one arrangement of the stack.
 *
 * Named by what is in it — `cleaningSignature`, over each repair's name and
 * place — so a balloon cleaned again is a different file, and a stale one is
 * never shown. One per page, like the preview: making one removes the page's
 * others.
 */

/** A page's repairs, as one short name — see above. Empty for a page with none. */
export function cleaningSignature (repairs: readonly Over[]): string {
  if (!repairs.length) return ''

  const text = repairs
    .map((over) => `${over.key ?? over.url}@${[over.sx, over.sy, over.sw, over.sh].map(Math.round).join(',')}`)
    .join(';')

  let hash = 2166136261

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}

export const cleaningName = (hash: string, size: Size, signature: string) => `${hash}@${size.height}~${signature}.webp`

/** The kept cleaning of a page at this size, for these repairs, or null. */
export function readCleaning (hash: string, size: Size, signature: string): Promise<File | null> {
  return opfsRead(ROOT, cleaningName(hash, size, signature))
}

/*
 * A sketch of each page: its preview with its cleaning drawn in, small enough
 * that every page of a chapter can be held at once — shown, soft, in place of
 * a page that is not ready yet, which is otherwise grey.
 *
 * Grey is what a page looks like while its scan and its cleaning decode, and
 * it is a choice: the alternative, the scan alone, shows the printed lettering
 * the cleaning is about to cover. Turning faster than those decode — a held
 * arrow key, 25–50 ms a page — showed every page of the run grey. A sketch is
 * a few milliseconds to decode and already decoded when it is wanted, and it
 * is the cleaned page, so it is neither.
 *
 * Lossy, unlike the preview and the cleaning: it is shown soft for a moment
 * and replaced, and it is held in memory for every page.
 */

/** How wide a sketch is. A 19-page chapter of them is about 25 MB decoded. */
export const SKETCH_WIDTH = 480

/** A page's sketch: its scan with this cleaning (`cleaningSignature`, empty for none). */
export const sketchName = (hash: string, signature: string) => `${hash}#sketch${signature ? `~${signature}` : ''}.webp`

export function readSketch (hash: string, signature: string): Promise<File | null> {
  return opfsRead(ROOT, sketchName(hash, signature))
}

/** One page to make a preview of — and its cleaning, where it has any. */
export interface PreviewPage {
  url: string
  file: File
  hash: string
  page: Size
  fit: Size
  /** The page's repairs, in the order they are drawn. */
  repairs?: Over[]
}

/**
 * The files being made right now, by name, whichever run asked for them — see
 * `keep`. Module-level because a run is stopped and another started every
 * time the chapter moves under it, and the point is that the second finds
 * the first's work.
 */
const making = new Map<string, Promise<boolean>>()

/**
 * Make one file here once, however many runs want it, and keep it once made —
 * even for a run that has stopped since. Says whether it was written.
 *
 * The workspace page starts the run again whenever a page gains its hash or
 * its width, the window changes size, or a balloon is cleaned, and during an
 * open that is several times a second's worth of quiet. A stopped run used to
 * throw away the file it was making: a preview of a 3732 × 5197 page is 590
 * ms of work, lost on every restart and made again straight after by the run
 * that replaced it. The names are content-addressed — the scan's hash, the
 * size, the repairs — so a file finished for a run nobody is waiting on is
 * still exactly that page at exactly that size, and it is written; and a run
 * that wants a file already being made waits for it rather than making it
 * twice.
 */
function keep (name: string, make: () => Promise<Blob | null | undefined>): Promise<boolean> {
  const pending = making.get(name)

  if (pending) return pending

  // `make` from a later turn, so the entry is in place before anything it does.
  const made = Promise.resolve()
    .then(make)
    .then((blob) => (blob ? opfsWrite(ROOT, name, blob) : false))
    .catch(() => false)

  making.set(name, made)
  made.then(() => { if (making.get(name) === made) making.delete(name) })

  return made
}

/**
 * Make the previews a chapter lacks, nearest the page on screen first, on the
 * background decoders — `lanes` pages at a time, one per decoder, since more
 * would only queue behind each other there. Stops when `stop` is called or
 * `paused` says to wait, checking again every second; what is already being
 * made when it stops is finished and kept (see `keep`).
 *
 * `workspace` is who they are for: its record of which scans it uses is
 * written first, before any file exists that a sweep could take for nobody's.
 *
 * The folder is listed once, as the run starts, for the files a new one
 * replaces (`dropOthers`). It was listed after every file written — up to
 * three times a page, and the folder is every chapter's previews at once.
 * A file some other run writes after the listing is left for the next run
 * that writes that page to find, or for `sweepPreviews`.
 */
export function makePreviews (workspace: string, pages: PreviewPage[], paused: () => boolean, lanes: number = backgroundDecoders()): { stop: () => void } {
  // An object, so the loops below see `stop` land between their awaits.
  const state = { stopped: false }

  const run = async () => {
    if (workspace) await idb.set(idbKey.previews(workspace), [...new Set(pages.map((one) => one.hash))]).catch(() => {})

    if (!pages.length) return

    const hashes = new Set(pages.map((one) => one.hash))
    const listed = new Set((await opfsNames(ROOT)).filter((name) => hashes.has(name.slice(0, 64))))

    let next = 0

    const lane = async () => {
      for (;;) {
        while (!state.stopped && paused()) await new Promise((resolve) => setTimeout(resolve, 1000))

        const one = pages[next++]

        if (state.stopped || !one) return

        await ready(one, listed, state)
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, pages.length)) }, lane))
  }

  run()

  return { stop: () => { state.stopped = true } }
}

/** One page's preview, sketch and cleaning, each made where it is missing. */
async function ready (one: PreviewPage, listed: Set<string>, state: { stopped: boolean }) {
  const size = previewSize(one.page, one.fit)

  if (!await readPreview(one.hash, size)) {
    const name = previewName(one.hash, size)

    // A page that will not decode has no preview; it is drawn from the scan
    // when turned to, as every page used to be.
    if (await keep(name, () => scanPreview(one.url, one.file, size.width, size.height)) && !state.stopped) {
      await dropOthers(one.hash, name, listed)
    }
  }

  if (state.stopped) return

  const signature = cleaningSignature(one.repairs ?? [])
  const repairs = (one.repairs ?? []).map(({ url, sx, sy, sw, sh }) => ({ url, sx, sy, sw, sh }))

  // The sketch, from the preview just made or found: the page as it looks
  // cleaned, small — see `SKETCH_WIDTH`. None where it cannot be made: the
  // page is grey while it decodes, as it was.
  if (!await readSketch(one.hash, signature)) {
    const base = await readPreview(one.hash, size)

    if (base) {
      const width = Math.min(SKETCH_WIDTH, one.page.width)
      const height = Math.max(1, Math.round(one.page.height * (width / one.page.width)))
      const name = sketchName(one.hash, signature)

      const made = await keep(name, async () => (await scanJob(jobKey('sketch'), base, {
        what: 'sketch',
        width,
        height,
        scale: width / one.page.width,
        repairs,
      }, false))?.blob)

      if (made && !state.stopped) await dropOtherSketches(one.hash, name, listed)
    }
  }

  if (state.stopped || !signature || await readCleaning(one.hash, size, signature)) return

  const name = cleaningName(one.hash, size, signature)

  // A repair that would not decode leaves no cleaning: the page goes on being
  // shown from its repairs one by one, as it was before there was this.
  const made = await keep(name, async () => (await scanJob(jobKey('cleaning'), one.file, {
    what: 'cleaning',
    width: size.width,
    height: size.height,
    scale: size.width / one.page.width,
    repairs,
  }, false))?.blob)

  if (made && !state.stopped) await dropOthers(one.hash, name, listed)
}

/**
 * The page's sketches of cleanings it no longer has, from the run's listing,
 * which is kept up to date with what the run removes and writes.
 */
async function dropOtherSketches (hash: string, kept: string, listed: Set<string>) {
  const dir = await opfsDir(ROOT).catch(() => null)

  for (const name of [...listed]) {
    if (name === kept || !name.startsWith(`${hash}#sketch`)) continue

    await dir?.removeEntry(name).catch(() => {})
    listed.delete(name)
  }

  listed.add(kept)
}

/**
 * Every other file of the same kind kept for this page — the scan's preview at
 * another size, or its cleaning at another size or of other repairs. A preview
 * and a cleaning are told apart by the `~` only a cleaning's name has. From the
 * run's listing, as above.
 */
async function dropOthers (hash: string, kept: string, listed: Set<string>) {
  const dir = await opfsDir(ROOT).catch(() => null)
  const cleaning = kept.includes('~')

  for (const name of [...listed]) {
    if (name === kept || !name.startsWith(`${hash}@`) || name.includes('~') !== cleaning) continue

    await dir?.removeEntry(name).catch(() => {})
    listed.delete(name)
  }

  listed.add(kept)
}

/**
 * Delete every preview no workspace names — after one has been deleted, which
 * took its record with it.
 *
 * Previews made before workspaces kept a record are named by none and go as
 * well. They are derived, and the next open of their chapter makes them again.
 */
export async function sweepPreviews () {
  const named = new Set<string>()

  for (const key of await idb.keys('previews:').catch(() => [] as string[])) {
    for (const hash of await idb.get<string[]>(key).catch(() => null) ?? []) named.add(hash)
  }

  const dir = await opfsDir(ROOT).catch(() => null)

  for (const name of await opfsNames(ROOT)) {
    // The scan's hash leads every name here — a preview, a cleaning, a sketch.
    if (!named.has(name.slice(0, 64))) await dir?.removeEntry(name).catch(() => {})
  }
}
