/**
 * Cleaning — the part of it the page engine reads, for now.
 *
 * In the web build this file is the whole of cleaning: running an inpainter
 * over each block, keeping the repairs, restoring them on open. That arrives
 * with the OCR pipeline (`utils/ocr/`). What is here already is what drawing a
 * page needs — the shape of a repair (`PagePatch`), the rule for whether one
 * still belongs to the scan it is laid over (`patchStands`), and the map the
 * engine reads them from (`usePatchMap`) — copied verbatim, so the engine is
 * carried across unchanged and simply finds no repairs yet.
 */
import type { ComicPage } from '~/composables/useComic'

/**
 * An upright region of the page, in image pixels from the top left — the web
 * build's `Region`, auto-imported there from `utils/ocr/manga.ts`, which has
 * not come across. The same four numbers as `Rect`, which it becomes again when
 * the OCR engines arrive.
 */
type Region = import('#shared/utils/raster').Rect


/** A cleaned block, as the canvas wants it: an image and a box in percentages. */
export interface PagePatch {
  url: string
  x: number
  y: number
  w: number
  h: number
  /**
   * The block's box, in page pixels, at the moment this was made — the
   * rectangle of the page this repair is a repair *of*.
   *
   * The anchor, and only the anchor. `x`/`y`/`w`/`h` above are the padded box
   * derived from it, and the canvas lays the image out at those rather than at
   * the block's — so the pixels stay over the artwork they were cut from
   * however the block is later moved, resized or turned. This says which
   * artwork that was, which is what a repair has to be able to say once its
   * block no longer agrees with it.
   */
  from: Region
  /**
   * The content hash of the scan this was cut from.
   *
   * A patch is artwork of a rectangle of *one page's pixels*, and the map it
   * lives in is keyed by the page's id — which is its path, `scan:6.jpg`.
   * Those two are not the same thing: open another chapter that also has a
   * `6.jpg` and the new page inherits the old one's repairs, drawn over
   * artwork nobody in this chapter has ever cleaned.
   *
   * The box comparison this replaces caught that by accident, and only when
   * the two chapters happened to disagree about where the balloons were. This
   * catches it on purpose.
   */
  scan: string
  /**
   * The name this repair is filed under — its recipe, model and mask source.
   * Only read by the dev Block images panel, where the recipe number is what
   * tells a current repair from an old one still being shown for its block.
   */
  key?: string
  /**
   * Shown from the page's record of what it last showed (`showKept`), before
   * `restore` has worked out what the page should show now. `restore` confirms
   * it, replaces it, or takes it down — see `showKept`.
   */
  provisional?: boolean
  /**
   * The SHA-256 of the picture, where the server has it — a cloud workspace's
   * repair shown from the server's list, or kept there from here.
   *
   * What lets a change notice be answered by comparing rather than by fetching:
   * a repair whose hash is the server's is already the one to show, and one
   * whose hash differs has been made again somewhere else. Absent for a repair
   * only this browser holds, which a notice then leaves alone.
   */
  hash?: string
}


/**
 * Whether a repair is still a repair of the page in front of us.
 *
 * ## What this used to say, and why it did not survive
 *
 * It used to compare the block's box against `patch.from` and withdraw the
 * repair the moment the two disagreed by more than a pixel, on the argument
 * that "a moved block shows no repair until it is cleaned again, which is the
 * honest state". That reasoning was wrong, and a bug report is what says so:
 * somebody cleaned a page, translated it, stretched a balloon's box to fit the
 * English, and watched the Chinese come back *through* their own lettering on
 * two balloons.
 *
 * The mistake was treating a patch as a property of the block. It is not. It is
 * artwork of a **rectangle of the page**, and once the lettering inside that
 * rectangle has been painted out it stays painted out — the rectangle does not
 * move because somebody edited a box afterwards. Drawing the repair at its own
 * `from` is not an orphan claiming to have repaired something that has moved;
 * it repaired that rectangle, and that rectangle is still there.
 *
 * The hazard the old comment named — a repair "dragged along with the block,
 * covering artwork it was never made from" — is real, and it argues for
 * **anchoring** the patch, never for hiding it. That anchoring is already how
 * the canvas draws: `patchStyle` lays the image out at `patch.x/y/w/h`, the
 * padded box derived from `from`, and never at the block's. So the pixels were
 * always going to stay put; withdrawing them bought nothing and cost the
 * cleaning.
 *
 * ## What still stands, and what no longer does
 *
 * Moving, resizing, turning, skewing or distorting a block no longer withdraws
 * its repair. **Growing** one is the case worth being explicit about: the patch
 * keeps its own smaller rectangle and the new area shows the original lettering,
 * because the artwork out there genuinely was never repaired. That is honest and
 * it stays true — it is now a strip of untouched page rather than the whole
 * balloon reverting.
 *
 * A repair is still dropped when it is not a repair of *this*:
 *
 * - the scan is not measured yet, so there is nowhere to put it;
 * - the scan is a different scan — see `PagePatch.scan`, the guard that
 *   replaces the box comparison rather than merely losing it;
 * - nothing is in the map at all, which is a block nobody has cleaned, or one
 *   whose re-clean found no lettering left and withdrew it (see `hide`);
 * - the block is deleted, which takes it out of the only loop that asks.
 *
 * And an explicit re-clean replaces it through `show`, which is the one way a
 * repair is meant to change.
 *
 * The retention the old comment was pleased about still works, and costs less
 * than it did: a nudge and a nudge back no longer has to make the patch
 * "current again", because it never stopped being shown. On disk the same is
 * true a level down — nudging back reproduces the old `patchKey`, so a re-clean
 * is a cache read.
 *
 * ## What this does not reach
 *
 * Only the session. `patchKey` names a repair partly by the region it was cut
 * for, so resizing a block mints a new name — and `restore` computes that name
 * from the block's box *as it now stands*, misses the file made for the old
 * one, and the page comes back with the repair absent rather than merely
 * unshown. Measured on Eclipse 2 page 6: ten patch files on disk for seven
 * blocks, five of the seven finding nothing after a reload.
 *
 * Closing that needs somewhere to write down which rectangle a block's repair
 * was cut for, which is a store this file does not have and a decision worth
 * making on its own. Nothing here is a workaround for it: anchoring is right
 * whether or not it is ever persisted.
 */
// `ComicPage['scan']` rather than `Scan`, which is two different interfaces
// here: `useComic`'s, meant, and `shared/utils/transform`'s bare width-and-height,
// which is the one an unqualified name resolves to.
export function patchStands (patch: PagePatch | null | undefined, scan: ComicPage['scan']): patch is PagePatch {
  if (!patch || !scan?.width || !scan.height) return false

  // Null while a freshly opened chapter is still being identified, and a patch
  // is never made without a hash — so an unhashed page withholds its repairs
  // for the moment it takes rather than showing the last chapter's.
  return patch.scan === scan.hash
}

/**
 * Every repair on screen, by page and block — the map `useClean` draws from.
 *
 * Reachable without `useClean` for the same reason the settings above are: a
 * block's id can change under it, and the thing that changes it is
 * `useBlockSync.adopt`, which must not reach for a composable that reaches for
 * `useComic` — see `renamePatch`.
 */
export const usePatchMap = () =>
  useState<Record<string, Record<string, PagePatch>>>('clean-patches', () => ({}))
