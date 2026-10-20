/**
 * Which of a page's two possible files a PDF hands over — decided by what this
 * browser and this workspace already hold under each.
 *
 * ## Why there are two
 *
 * A PDF image stored as Flate over PNG-predicted rows used to be inflated, its
 * predictor undone row by row in JavaScript, and deflated again as a PNG: about
 * 0.7 s a page in the browser, on every visit to a chapter kept by folder
 * handle, since that chapter's PDF is read again each time. Those same bytes
 * are already a PNG's image data, so they are now put into one as they are
 * (`wrapPng`, `extract.ts`) — the same pixels, a different file, no deflate.
 *
 * A different file is a different page. A scan's SHA-256 is its identity
 * everywhere: the reading, layer stack and cleaning of a local workspace are
 * filed under it in IndexedDB (`blocks:`, `layers:`, `repairs-shown:`), the
 * retouching under it (`paint:`), thumbnails, previews and repairs under it in
 * OPFS; a cloud workspace's `pages.hash` holds it, the server matches a folder
 * held up to be recognised by it (`rowFor`, and `byName` refuses a path whose
 * hash disagrees), and every peer asks for the page by it. A chapter opened
 * before this change and read the new way would come back as pages nothing
 * recognises: its work would still be on disk and on the server, filed under
 * names no page has any more, and a cloud chapter's sync would be refused
 * outright as "a different scan" at every path.
 *
 * ## The rule
 *
 * So the new file is used only where the old one is not already somebody's
 * page. For every page the new road applies to:
 *
 * 1. The new file, if its hash is known — the book was opened the new way
 *    before, here or by whoever filed the workspace's rows.
 * 2. Otherwise the old file, made the old way, if *its* hash is known — a
 *    chapter opened before this change. It goes on being read the old way, at
 *    the old cost, for good; nothing is re-keyed and nothing is written to the
 *    server, which is the whole of what makes this safe.
 * 3. Otherwise neither is anybody's page yet, and the new file is taken.
 *
 * Making the old file to find out costs what the old road cost, so a book that
 * nobody holds stops asking after `PROBES` pages that neither file is known
 * for — a new book pays for two old-road pages rather than all of them, and a
 * browser holding nothing at all pays for none. That shortcut is withheld
 * where the book is known to be one this workspace has had before (`held`): a
 * chapter restored from its kept folder, or a PDF whose path the workspace's
 * rows already name. There every page is checked both ways, however many of
 * the first ones are unknown — a cover and credits pages deleted from a
 * chapter must not decide how the rest of it is read.
 *
 * What counts as "known" is `known.ts`: every scan hash this browser has filed
 * anything under, and the workspace's page rows. It runs on the page's thread
 * (IndexedDB, OPFS, the workspace record) and crosses to the worker as a list.
 *
 * This file is imported by the worker, so it imports nothing auto-imported.
 */

/**
 * How many pages of an unheld book are checked the old way, finding neither
 * file known, before the book is taken to be new. Two, so one missing page is
 * not the whole decision, and a new book costs two slow pages rather than one.
 */
export const PROBES = 2

/**
 * How long a prefix of a hash is compared. Sixteen hex characters is what a
 * patch key carries of its scan (`patchKey`), and 64 bits is far past where
 * two different pages of one browser could meet by chance.
 */
export const PREFIX = 16

/** What a book's pages are checked against. */
export interface Known {
  /** Hash prefixes (`PREFIX` long) of every scan something is filed under. */
  scans: ReadonlySet<string>
  /** The workspace is known to have had this book before — see the header. */
  held: boolean
}

/** Knowing nothing: a new workspace in a new browser, or a caller with no workspace. */
export const NOTHING_KNOWN: Known = { scans: new Set(), held: false }

/** A page's file, as far as choosing between two of them needs one. */
interface Candidate { data: Uint8Array }

/**
 * SHA-256 in lowercase hex — `utils/hash.ts`'s digest, which is the page's
 * identity. Not imported from there because that file reaches for the
 * auto-imported store, and this one runs in the worker; the two must stay the
 * same function.
 */
export async function digest (data: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', data as BufferSource)

  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The choosing for one book, page by page.
 *
 * Both files are made only when asked for, because each costs something: the
 * new one an inflate to check it, the old one the old road's whole price. The
 * order is what keeps a book on either road cheap once it is known to be on
 * it — a new book never makes an old file past its probes, and a book found
 * to be old (`old`) makes its old file *first*, so a chapter opened before
 * this change costs what it always cost plus one digest a page, rather than
 * paying for both files every visit to confirm what the first page settled.
 * The new file is still checked for, after, on a page whose old file nobody
 * knows: that is a page first seen after this change, and it came out new.
 *
 * `known` may still be on its way when the first page is ready — the worker
 * starts on the file while the page's thread is still listing its stores and
 * waiting for the workspace record — and is only waited on by a page that has
 * two files to choose between. A book of JPEGs never waits at all.
 */
export class Choosing<T extends Candidate> {
  private misses = 0
  private held: boolean | null = null
  /** An old book: a page's old file was known, so later pages try it first. */
  private old = false

  constructor (private readonly known: Known | Promise<Known>) {}

  /**
   * One page's file. `fresh` is null where the new road turned the page away
   * after all (its stream did not inflate to its rows); `old` failing is not
   * the page failing while there is a new file to give.
   */
  async choose (fresh: () => Promise<T | null>, old: () => Promise<T | string | null>): Promise<T | string | null> {
    const known = await Promise.resolve(this.known).catch(() => NOTHING_KNOWN)
    const isKnown = async (file: T | string | null | undefined) =>
      Boolean(file && typeof file !== 'string' && known.scans.has((await digest(file.data)).slice(0, PREFIX)))

    this.held ??= known.held

    let before: T | string | null | undefined

    if (this.old) {
      before = await old().catch(() => null)

      if (await isKnown(before)) return before as T
    }

    const made = await fresh()

    if (!made) return before !== undefined ? before : old()

    // Nothing anywhere to be matched against, and nothing to keep faith with.
    if (!known.scans.size && !this.held) return made

    if (await isKnown(made)) return made

    if (!this.held && this.misses >= PROBES) return made

    if (before === undefined) {
      before = await old().catch(() => null)

      if (await isKnown(before)) {
        // An old chapter. Every later page tries the old road first and is
        // checked both ways, whatever the count of misses says.
        this.old = true
        this.held = true

        return before as T
      }
    }

    this.misses++

    return made
  }
}
