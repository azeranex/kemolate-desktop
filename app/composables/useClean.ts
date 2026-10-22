/**
 * Painting the lettering out of the open chapter, block by block.
 *
 * The seam between `utils/ocr/clean.ts`, which knows how to fill a hole, and
 * the workspace, which knows what a page is. It runs the inpainter over a
 * page's blocks, keeps the results in the patch cache, and hands the canvas
 * something it can draw.
 *
 * Nothing here is destructive. A patch is a separate image laid over the
 * scan on the cleaned plate; the scan itself is never touched, which is why
 * turning the plate off still shows the original lettering underneath and
 * why a cleaning can be thrown away by deleting a cached file.
 *
 * ## Why the cache is consulted before the model
 *
 * Cleaning is the expensive step in the whole pipeline — seconds a balloon,
 * against milliseconds for everything else. The cache is keyed by what a
 * patch is made from (see `patches.ts`), so opening a chapter that was
 * cleaned yesterday costs a handful of file reads, and re-reading a page
 * does not re-clean the balloons whose boxes did not move.
 */
import type { RepairRow } from '#shared/utils/repairs'
import type { Inpainter, InpainterModel } from '~/utils/ocr/clean'
import type { MaskSource } from '~/utils/ocr/mask'
import type { PatchKey } from '~/utils/ocr/patches'

// Named rather than auto-imported so a running dev server picks them up without a restart.
import { idbKey } from '~/utils/idbKeys'
import { repairsAreQuick } from '~/utils/ocr/clean'
import { blockOutline, partsWithin } from '~/utils/ocr/mask'
import { MASK_RECIPE, patchMade } from '~/utils/ocr/patches'
import { drawsRepair } from '~/utils/raster/engine/overs'
import { REPAIR_DOWNLOADS } from '~/utils/resources'

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

export interface CleanProgress {
  page: number
  pages: number
  message: string
  step?: { done: number, total: number }
  /** Blocks cleaned so far in this run, cache hits included. */
  done: number
}

/**
 * How long the pointer is left alone before a corrected block is re-cleaned.
 *
 * Inference used to run on this thread, and a repair froze the page for as
 * long as it took — the brush started one the instant a stroke ended, so
 * four quick strokes meant four freezes. The runtime now proxies inference
 * into a worker (see `ortOnce`), so the page stays live through a repair;
 * the wait remains because the *work* is still real: three of four repairs
 * started mid-flurry are thrown away by the next correction anyway.
 *
 * Long enough that a run of strokes is one repair, short enough that
 * stopping to look at what you have done produces one without being asked.
 */
const SETTLE = 700

/**
 * The same wait when starting a repair early costs nothing — see
 * `repairsAreQuick`. `SETTLE` is kept for a model known to be on
 * single-threaded wasm, and for a browser with no WebGPU.
 *
 * 700 ms was sized for repairs that took seconds and could not be called off.
 * Both have changed: a stroke now abandons the repair of its block, and on
 * WebGPU a repair is half a second at worst — and a caption on blank paper,
 * filled rather than inpainted, is under 60 ms. The wait was
 * then most of what a correction cost (0.7 of 0.8 s on page 19 of the istani
 * chapter), so it shrinks to the gap between two strokes of one flurry.
 */
const SETTLE_QUICK = 250

/**
 * Blocks a correction has invalidated, as `page` and `block` ids.
 *
 * Ids rather than the objects, because a block is replaced wholesale when it
 * is edited and a held reference would clean the geometry it used to have.
 * Outside the composable so the wait survives the brush being put down.
 */
const waiting = new Set<string>()

let settle: ReturnType<typeof setTimeout> | null = null

/** The chapter opening (`epoch`) whose stale repairs have been swept — see `sweepOnce`. */
let swept = -1

/**
 * The repair running for a block right now, so a correction can call it off —
 * by the same `page\u0000block` key as `waiting`.
 *
 * A stroke used to have to wait for the previous stroke's repair: the brush
 * refused to start while a clean ran, and the clean it was waiting on was of a
 * mask the reader was already busy changing. Now a correction abandons the
 * repair of its block (see `CleanOptions.signal`) and the brush never waits;
 * the block is cleaned once, after the hand has stopped.
 */
const repairing = new Map<string, AbortController>()

const blockKey = (pageId: string, blockId: string) => `${pageId}\u0000${blockId}`

/**
 * Call off the repair running for this block, if any — its mask is changing.
 *
 * What the brush asks the moment a stroke starts, so the inference behind it
 * stops at its next seam instead of finishing a picture nobody will see.
 */
export function abandonClean (pageId: string, blockId: string) {
  repairing.get(blockKey(pageId, blockId))?.abort()
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
 * How this machine cleans: which inpainter fills the hole, and which answer
 * decides where the hole is.
 *
 * `segmenter` is off by default and it is a real default rather than a
 * timidity. The learned mask is better on the cases the threshold is worst at
 * — see `segment.ts` — but it is a model to download before the first balloon
 * is repaired, and a chapter that cleans today on a slow connection must go on
 * cleaning today. So it is opt-in, and the cost is what it is opting into.
 *
 * Reachable without `useClean`, the way `useLayerRows` is reachable without
 * `useLayerSync`, because **both fields are part of a patch's name**:
 * `patchKey` stamps the model and the mask source into every key, so a project
 * file that carried repairs without carrying these would carry pictures nothing
 * would ever look up. `useProjectFile` needs them and must not call `useClean`
 * to get them — that reaches `useComic`, which registers a watcher of its own.
 */
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

/**
 * A block's repair, carried from the id it had to the id it has now.
 *
 * Repairs are held by block id, and a block's id is not fixed for its life. One
 * put back from this browser's cache arrives as `read:…` (see `localise`), and
 * moments later `useBlockSync` saves it and renames it in place to `block:<row>`.
 * `restore` had run in between and filed every repair under the old name — so
 * the chapter opened with its cleaning found and then not drawn, and switching
 * cleaner and back brought it all up, because that runs `restore` again under
 * the names the blocks have by then. The same happened to a balloon cleaned
 * before its row existed.
 *
 * Pure over the map it is handed, so the rule can be tested without a page.
 */
export function renamePatch (
  map: Record<string, Record<string, PagePatch>>,
  pageId: string,
  from: string,
  to: string,
): Record<string, Record<string, PagePatch>> {
  const onPage = map[pageId]
  const patch = onPage?.[from]

  if (!onPage || !patch || from === to) return map

  const { [from]: _gone, ...rest } = onPage

  // A repair already filed under the new name is newer than the one being
  // carried — it was made for the block as it is now — so it is kept, and the
  // old one is only dropped from the map. Its object URL goes with it.
  if (rest[to]) {
    URL.revokeObjectURL(patch.url)

    return { ...map, [pageId]: rest }
  }

  return { ...map, [pageId]: { ...rest, [to]: patch } }
}

/**
 * Every name a block's repair could be on disk under, best first.
 *
 * The chosen cleaner decides how the *next* repair is made. It used to decide
 * which existing ones were shown as well, and that was the bug behind "the
 * cleaning does not load": a chapter was cleaned by an auto run with AOT, the
 * reader tried LaMa on one page, and from then on every reload asked the disk
 * for LaMa repairs only. 151 AOT repairs sat there matching their blocks
 * exactly, and five pages' worth of LaMa were all that came back. Switching
 * cleaner and back looked like it fixed it only when "back" happened to be AOT.
 *
 * So a repair made any way is shown. The one the current settings would make
 * comes first, because it is what a Clean press would produce; then the same
 * model from the other mask; then every other model, current mask first. A
 * press of Clean still makes a repair with the chosen cleaner and replaces
 * what is shown, which is the one way a repair is meant to change.
 */
export function restoreKeys (
  base: Omit<PatchKey, 'model' | 'source'>,
  model: InpainterModel,
  source: MaskSource,
): string[] {
  const other: MaskSource = source === 'segmenter' ? 'threshold' : 'segmenter'
  const models = [model, ...INPAINTERS.map((spec) => spec.id).filter((id) => id !== model)]

  return [
    patchKey({ ...base, model, source }),
    patchKey({ ...base, model, source: other }),
    ...models.slice(1).flatMap((each) => [
      patchKey({ ...base, model: each, source }),
      patchKey({ ...base, model: each, source: other }),
    ]),
  ]
}

/**
 * Run some jobs, at most `limit` at a time, in the order given.
 *
 * Order matters to `restore`, which puts the page on screen first: a pool that
 * started jobs out of turn would spend the first reads on page forty. `borrow`
 * uses it to bound its downloads — see `REPAIR_DOWNLOADS`.
 */
async function inParallel (jobs: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0

  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!()
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

/** What one run of the cleaner carries from page to page — see `useClean.run`. */
interface CleanRun {
  /** Every block's corrections, read once for the chapter — see `chapterEdits`. */
  chapter: Map<string, MaskEdit[]> | null
  /** The workspace the run was started in, which is the one its requests go to. */
  workspace: string
  /** The workspace's repairs, listed once for the run — see `listOnce`. */
  rows: () => Promise<RepairRow[] | null>
  /** Aborted when the run is stopped. */
  signal: AbortSignal
}

/**
 * The workspace's repair list, asked for once a run rather than once a page.
 *
 * It is the whole chapter's list — the server has no narrower one to give — so
 * every page after the first asked again for rows it had already been sent:
 * forty requests for a forty-page chapter, each carrying all forty pages' rows.
 * Asked for by the first page with a block this disk has no repair for, so a
 * run over a chapter already cleaned here asks for nothing, as before.
 *
 * A list that did not arrive is not remembered, and the next page asks again,
 * as every page used to. One that did is a snapshot, and a repair somebody
 * keeps while the run is still going is not in it: that balloon is cleaned here
 * rather than borrowed. Every page but the first already risked that for as
 * long as the page ahead of it took; now it is for as long as the run takes.
 */
function listOnce (workspace: string, signal: AbortSignal): () => Promise<RepairRow[] | null> {
  let asked: Promise<RepairRow[] | null> | null = null

  return () => {
    asked ??= $fetch<RepairRow[]>(`/api/workspaces/${workspace}/repairs`, { signal }).catch(() => {
      asked = null

      return null
    })

    return asked
  }
}

/** How this browser cleans — see `settings` in `useClean`. */
export const useCleanSettings = () => useState<{ model: Inpainter, segmenter: boolean }>(
  'clean-settings',
  () => ({ model: 'aot', segmenter: false }),
)

export function useClean () {
  const { pages, page, at, measure, epoch } = useComic()

  // A block's corrections are part of what its patch is made from, so they
  // are read here rather than being something the caller has to remember.
  const { load, chapterEdits, editsFrom } = useMaskEdits()

  // For a cloud workspace, whose repairs are kept on the server too — see
  // `keepRemotely` and `restore`.
  const { shared, pageRowOf } = useShared()

  /**
   * How this machine cleans: which inpainter fills the hole, and which answer
   * decides where the hole is.
   *
   * `segmenter` is off by default and it is a real default rather than a
   * timidity. The learned mask is better on the cases the threshold is worst
   * at — see `segment.ts` — but it is a model to download before the first
   * balloon is repaired, and a chapter that cleans today on a slow connection
   * must go on cleaning today. So it is opt-in, and the cost is what it is
   * opting into.
   */
  const settings = useCleanSettings()

  /**
   * Kept between sessions, and only if it still names an inpainter we have.
   *
   * Each field is accepted on its own, so an entry written before `segmenter`
   * existed reads as the default rather than as `undefined` — a stored
   * setting that quietly unsets a field is how a boolean ends up neither true
   * nor false and every `if` on it takes the wrong branch.
   */
  remember('kemolate:clean', settings, (held) => ({
    // `CLEANERS` and not `INPAINTERS`, so that "None" is a choice that survives
    // a reload. Held to the list either way: a stored value naming a model we
    // no longer ship reads as the default rather than as a cleaner nothing has.
    ...(CLEANERS.some((item) => item.id === held.model) ? { model: held.model as Inpainter } : {}),
    ...(typeof held.segmenter === 'boolean' ? { segmenter: held.segmenter } : {}),
  }))

  /**
   * What a patch made right now would be made from, in the two places that
   * have to agree about it: the name it is filed under, and the run that
   * makes it.
   *
   * Read at the moment of use rather than held, because the toggle can be
   * flipped between a cache lookup and the repair that follows it — and a key
   * that named one mask while the run made the other would file a repair under
   * a name that will never be asked for again.
   */
  const maskSource = (): MaskSource => (settings.value.segmenter ? 'segmenter' : 'threshold')
  const segmentOver = (hash: string) => (settings.value.segmenter ? { scan: hash } : undefined)

  const progress = useState<CleanProgress | null>('clean-progress', () => null)
  const error = useState<string | null>('clean-error', () => null)

  /**
   * Blocks the last run could not mask, and why. Cleared when a run starts.
   *
   * The reasons have always existed — the threshold and the crop both say out
   * loud what they refused — but only to the console, which nobody translating
   * a chapter has open. A block that quietly declines to clean, on a page where
   * ten others cleaned, reads as the app being broken rather than as a box
   * drawn over artwork, and there was no way to find out which from inside the
   * app.
   *
   * A block is here only when it ends up with **no mask at all**. A balloon
   * whose fifth line was refused and whose other four masked cleanly has
   * cleaned, and reporting it would turn a success into an alarm.
   */
  const skipped = useState<{ pageId: string, blockId: string, why: string }[]>('clean-skipped', () => [])

  /** One block's reason, replacing whatever was said about it before. */
  function note (pageId: string, blockId: string, why: string) {
    skipped.value = [
      ...skipped.value.filter((item) => item.pageId !== pageId || item.blockId !== blockId),
      { pageId, blockId, why },
    ]
  }

  /** Its reason withdrawn, because it is about to be answered again. */
  function unnote (pageId: string, blockId: string) {
    skipped.value = skipped.value.filter((item) => item.pageId !== pageId || item.blockId !== blockId)
  }

  /**
   * Every patch on screen, by page and block.
   *
   * Keyed by both because a block id is only unique within its page, and
   * because the canvas asks for one page's worth at a time.
   */
  const patches = usePatchMap()

  const running = computed(() => progress.value !== null)

  /**
   * A cleaner that is not a cleaner, and everything downstream that follows.
   *
   * `none` is the reader saying their pages arrive already cleaned — see
   * `NO_CLEANER`. Asked as a computed rather than inline at each of the four
   * gates below, because four copies of `settings.value.model !== 'none'` is
   * four places to forget when a second such choice exists.
   */
  const repairs = computed(() => cleanerRuns(settings.value.model))

  const canClean = computed(() => repairs.value && Boolean(page.value?.scan && page.value.blocks.length))

  /**
   * What a block covers, in the page's own pixels — the upright rectangle
   * around it *as turned*, which for a tilted block is not its `x/y/w/h`. See
   * `blockOutline`, and `outlineOf` for the shape the mask is kept inside.
   */
  function regionOf (block: Block, scan: { width: number, height: number }): Region {
    return blockOutline(block, scan.width, scan.height).region
  }

  /** A turned block's outline in page pixels, or null for an upright one. */
  const outlineOf = (block: Block, scan: { width: number, height: number }) =>
    blockOutline(block, scan.width, scan.height).outline

  /**
   * A box in page pixels, back in the percentages the canvas lays out with.
   *
   * Always the *padded* box — a patch covers more than its block, because
   * the inpainter is given real artwork around the hole to work from.
   */
  function boxOf (box: Region, scan: { width: number, height: number }): Omit<PagePatch, 'url' | 'from' | 'scan'> {
    return {
      x: (box.x / scan.width) * 100,
      y: (box.y / scan.height) * 100,
      w: (box.w / scan.width) * 100,
      h: (box.h / scan.height) * 100,
    }
  }

  /** Hand a patch to the canvas, letting go of whatever it replaces. */
  function show (pageId: string, blockId: string, patch: PagePatch) {
    const held = patches.value[pageId]?.[blockId]

    if (held) URL.revokeObjectURL(held.url)

    patches.value[pageId] = { ...patches.value[pageId], [blockId]: patch }
  }

  /**
   * A repair shown from the record, found right by `restore` — the same file,
   * laid where `restore` has just worked out it goes.
   *
   * The picture is kept and the place is not. The record holds the place as
   * shares of the page, written when the page was last on screen, and a page
   * once on screen at the wrong size — another page's, from a late image load
   * — wrote down places that were wrong by the difference, and every open after
   * that showed its repairs off the art. Laid again here, a bad record heals on
   * the next open and is written back right.
   */
  function confirm (pageId: string, blockId: string, place: Pick<PagePatch, 'x' | 'y' | 'w' | 'h' | 'from'>) {
    const held = patches.value[pageId]?.[blockId]

    if (held?.provisional) patches.value[pageId] = { ...patches.value[pageId], [blockId]: { ...held, ...place, provisional: false } }
  }

  /**
   * Where a page's record of the repairs it last showed is kept — see `showKept`.
   * Per workspace and scan, so the same picture in another chapter is not
   * mistaken for this one.
   */
  const recordOf = (hash: string) => idbKey.repairsShown(workspaceOf(), hash)

  interface Kept {
    block: string
    key: string
    x: number
    y: number
    w: number
    h: number
    from: Region
    /** The server's hash for it, where known — see `PagePatch.hash`. */
    hash?: string
  }

  /**
   * Put up the repairs a page showed last time, straight from disk.
   *
   * Opening a chapter showed the page at once and its cleaning a second and a
   * half later — the printed lettering under the translation for all that time
   * (1.09s to 2.53s, recorded on page 7 of Business trip grooming 2). `restore`
   * cannot be quicker without cutting corners: to know which repair belongs to
   * a block it needs the settings, the list of files on disk, the server's list
   * and every block's mask corrections. But the page somebody opens on is almost
   * always showing exactly what it showed when they left it.
   *
   * So each page keeps a small record of that (`keepShown`), and this shows it
   * the moment the page is on screen — marked provisional, because the record
   * can be out of date. `restore` then either confirms each one (the usual
   * case: nothing moves), replaces it with what it works out, or takes it down
   * if the block has no repair any more. The record only ever gets the page
   * there sooner, never to a different answer.
   */
  async function showKept (target: ComicPage | undefined) {
    const hash = target?.scan?.hash

    if (!target || !hash || !cleanerRuns(settings.value.model)) return

    const kept = await idb.get<{ v: 1, repairs: Kept[] }>(recordOf(hash)).catch(() => undefined)

    if (kept?.v !== 1) return

    await Promise.all(kept.repairs.map(async (entry) => {
      if (patches.value[target.id]?.[entry.block]) return

      const held = await readPatch(entry.key).catch(() => null)

      // Checked again after the read: `restore` may have got there first.
      if (!held || patches.value[target.id]?.[entry.block]) return

      show(target.id, entry.block, {
        url: URL.createObjectURL(held),
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        from: entry.from,
        scan: hash,
        key: entry.key,
        provisional: true,
        ...(entry.hash ? { hash: entry.hash } : {}),
      })
    }))
  }

  /** Write down what a page is showing now, for `showKept` next time. */
  async function keepShown (target: ComicPage | undefined) {
    const hash = target?.scan?.hash

    if (!target || !hash) return

    const repairs: Kept[] = Object.entries(patches.value[target.id] ?? {})
      .filter(([, patch]) => patch.key && patch.scan === hash)
      // `from` copied out field by field: it is a reactive proxy, and IndexedDB
      // refuses to clone one — the record was silently never written.
      .map(([block, patch]) => ({
        block,
        key: patch.key!,
        x: patch.x,
        y: patch.y,
        w: patch.w,
        h: patch.h,
        from: { x: patch.from.x, y: patch.from.y, w: patch.from.w, h: patch.from.h },
        ...(patch.hash ? { hash: patch.hash } : {}),
      }))

    await idb.set(recordOf(hash), { v: 1, repairs }).catch(() => {})
  }

  /**
   * One block's repair, taken back off the page.
   *
   * The counterpart to `show`, and the thing whose absence read as a bug: a
   * clean that finds nothing to repair used to simply return, which is right
   * for a block that has never been cleaned and wrong for one that has. Erase a
   * mask and the block re-cleans, finds nothing left to paint out, and the
   * repair made from the *old* mask stayed on the plate — artwork covered by a
   * patch of something that is no longer there, with no way to shift it short
   * of deleting the block.
   *
   * The cached file on disk is left alone deliberately. It is keyed by the
   * corrections it was made from (`patchKey`), so it is not this mask's repair
   * any more and nothing will ask for it again; undoing the erase asks for the
   * old key, and the answer is still there.
   */
  function hide (pageId: string, blockId: string) {
    const held = patches.value[pageId]?.[blockId]

    if (!held) return

    URL.revokeObjectURL(held.url)

    const { [blockId]: _gone, ...rest } = patches.value[pageId] ?? {}

    patches.value = { ...patches.value, [pageId]: rest }
  }

  /** Everything drawn for one page, dropped — the display only; the disk keeps its files. */
  function forget (pageId: string) {
    for (const patch of Object.values(patches.value[pageId] ?? {})) URL.revokeObjectURL(patch.url)

    const { [pageId]: _gone, ...rest } = patches.value

    patches.value = rest
  }

  /**
   * The blocks worth cleaning: the ones that are lettering.
   *
   * A joined balloon is one block here — see `Block.children` — so it is
   * painted out as one rectangle without this having to ask. Cleaning its
   * columns separately would leave the strips between their boxes untouched,
   * showing as seams of leftover balloon between the repairs.
   */
  const lettering = (target: ComicPage) =>
    target.blocks.filter((block) => block.type !== 'garbage' && !block.hidden)

  /**
   * The pieces a block's mask is thresholded over, in page pixels.
   *
   * The other half of the sentence above, and the one exception to it: the
   * *patch* is one rectangle, but the *threshold* cannot be. Otsu picks a
   * single grey level, and a five-line info balloon printed at five weights
   * has its faint lines fall on the background side of whatever the dark ones
   * chose — no ink, nothing painted, no warning, and the bottom two lines
   * survive the repair while the top three vanish.
   *
   * A joined balloon's children are already exact per-line boxes, so the
   * regions cost nothing to come by. Empty for an ordinary block, which is
   * nearly all of them, and then the block's own box is the one region — see
   * `autoMaskOver`.
   */
  const partsOf = (block: Block, scan: { width: number, height: number }) =>
    partsWithin((block.children ?? []).map((child) => regionOf(child, scan)), regionOf(block, scan))

  /**
   * Whether the page's own pixel size is known, measuring it here if nothing
   * has yet.
   *
   * Every box in this file is a share of that size, so a page without one
   * cannot be cleaned or have its cleaning put back. It used to be the third
   * prerequisite of both and the only one nobody waits for: the hash is a
   * dependency of the watcher that calls `restore`, and the blocks are awaited
   * a line above it, but the size lands in `openImages`' un-awaited `rest`
   * loop — a header read per page, one page at a time, racing the hashing loop
   * for the same disk.
   *
   * Lose that race and the page was skipped *for good*. Nothing runs `restore`
   * again when a size arrives, so a chapter came back with the cleaning missing
   * from whichever pages happened to be behind, and pressing Clean on one put
   * every repair up instantly — because they had all been on disk the whole
   * time and only the size was late. On a chapter opened before, hashes come
   * back memoised from IndexedDB (`hashFile`) while the sizes are still being
   * read off the files, so the second visit is where it bites hardest, which is
   * exactly the visit that has cleaning to restore.
   *
   * Reading the header here costs what `rest` was about to spend anyway — it
   * skips a page that already has a size, and this fills the same field — and
   * being asked for rather than waited on is the whole of what stops it being a
   * race.
   *
   * False for a header the sniff cannot read (see `imageDimensions`), which is
   * the one case still settled by drawing the page. Those restore on the next
   * visit rather than this one, and there is no cheaper answer than a decode.
   */
  async function measured (target: ComicPage): Promise<boolean> {
    const scan = target.scan

    if (!scan) return false
    if (scan.width && scan.height) return true

    const found = await imageDimensions(scan.file).catch(() => null)

    if (found) measure(target.id, found.width, found.height)

    return Boolean(scan.width && scan.height)
  }

  /**
   * Which workspace this is happening in, or nothing.
   *
   * Read on demand rather than held from setup, and the awkwardness is the
   * point. `useClean` is reached from callbacks as well as from components —
   * see `useMaskEdits` — so anything it asked for during setup would sometimes
   * be asked for with no component to own it. A route read is safe to do late;
   * a composable that registers watchers is not.
   *
   * Empty outside a workspace, and on the server, where none of what it is used
   * for exists anyway. Sharing repairs is an optimisation on top of a pipeline
   * that has always worked alone, so every way of not knowing means the same
   * thing: clean it here.
   */
  function workspaceOf (): string {
    if (!import.meta.client) return ''

    try {
      return String(useRoute().params.workspaceId ?? '')
    } catch {
      return ''
    }
  }

  /**
   * Whether this is a cloud workspace — one whose repairs the server keeps too.
   *
   * See `repairs` in the schema. A local workspace keeps its repairs in this
   * browser and nowhere else, which is what a local workspace is.
   */
  const inCloud = () => Boolean(workspaceOf() && shared.value)

  /** Whether this browser may add to what the cloud workspace keeps. */
  const keepsRepairs = () => inCloud() && atLeast(shared.value?.role, 'editor')

  /**
   * Keep a repair on the server as well as on this machine.
   *
   * Beside `writePatch` at every place a repair is made or borrowed, and never
   * waited for: the repair is on the page and on this disk already, and a
   * server that did not take it costs another browser a clean, not this one
   * anything. Filed against the block's row where it has one, which is what
   * lets a reload find it after the block has moved — see `repairFor`.
   */
  async function keepRemotely (target: ComicPage, block: Block, key: string, image: Blob, from: Region, box: Region) {
    if (!keepsRepairs()) return

    const pageId = pageRowOf(target)

    if (!pageId) return

    const rect = (value: Region) => [value.x, value.y, value.w, value.h].join(',')

    const row = await $fetch<RepairRow>(`/api/workspaces/${workspaceOf()}/repairs`, {
      method: 'PUT',
      query: { pageId, blockId: rowOf(block) ?? '', key, from: rect(from), box: rect(box) },
      body: image,
      headers: { 'content-type': 'image/png' },
    }).catch((error: unknown) => {
      console.warn('[kemolate] repair not kept on the server:', error)

      return null
    })

    // Now the server's, and known to be: a notice about this page will find
    // the hash it has and leave the repair alone. Only if it is still the one
    // on screen — a clean that finished meanwhile put up another.
    const held = row && patches.value[target.id]?.[block.id]

    if (row && held?.key === row.key) patches.value[target.id] = { ...patches.value[target.id], [block.id]: { ...held, hash: row.hash } }
  }

  /**
   * Take a block's repairs back off the server — `hide`'s other half.
   *
   * A clean that found nothing left to paint out withdraws the repair on
   * screen; without this the server would go on offering it as the block's
   * newest, and the next reload would put it back.
   */
  function withdrawRemotely (block: Block) {
    const row = rowOf(block)

    if (!keepsRepairs() || !row) return

    $fetch(`/api/workspaces/${workspaceOf()}/repairs`, { method: 'DELETE', query: { blockId: row } })
      .catch(() => {})
  }

  /**
   * The repairs this page needs that somebody in the workspace has already
   * made — from the server, which keeps a cloud workspace's repairs.
   *
   * A repair is named by what it was made from, so anybody who cleaned this
   * scan with this model and these corrections has already produced the thing
   * this browser is about to spend seconds producing. It used to be asked of
   * the other browsers in the room, peer to peer; since the server keeps every
   * repair an editor makes, that road only ever found what the server already
   * had, and it is gone.
   *
   * Empty for a local workspace, and whenever the server does not answer:
   * either way the caller cleans the block itself.
   *
   * The list is the run's, asked for once (see `listOnce`), and the repairs
   * come down `REPAIR_DOWNLOADS` at a time rather than one after another: a
   * page of fifteen balloons somebody else had cleaned was fifteen round trips
   * in a row before the first one could be shown. A stopped run starts no more
   * of them and calls off the ones in flight — what arrives anyway is not kept,
   * see `cleanOne`.
   */
  async function borrow (target: ComicPage, keys: string[], run: CleanRun): Promise<Map<string, { bytes: Blob, row: RepairRow }>> {
    const pageRow = pageRowOf(target)
    const out = new Map<string, { bytes: Blob, row: RepairRow }>()

    if (!inCloud() || !run.workspace || !pageRow || !keys.length) return out

    const wanted = new Set(keys)
    const rows = ((await run.rows()) ?? []).filter((row) => row.pageId === pageRow && wanted.has(row.key))

    await inParallel(rows.map((row) => async () => {
      if (run.signal.aborted) return

      const bytes = await $fetch<Blob>(`/api/workspaces/${run.workspace}/repairs/${row.hash}`, { responseType: 'blob', signal: run.signal })
        .catch(() => null)

      if (bytes) out.set(row.key, { bytes, row })
    }), REPAIR_DOWNLOADS)

    return out
  }

  /**
   * One page. Cache first, model only for what is missing.
   *
   * A page whose scan has not been measured is skipped rather than guessed
   * at: every box here is a share of a size, and cleaning the wrong part of
   * a page is worse than not cleaning it.
   *
   * ## Kept whole, or not at all
   *
   * What a page gets — the repairs borrowed from the server, then the ones
   * made here — is kept in one sweep each: every file started, every repair
   * shown, every one made here sent up, with nothing awaited between one
   * repair and the next. The run's stop (see `run`) lands between two tasks,
   * never inside a sweep, so a stopped run leaves each of them kept whole or
   * not at all. It used to await each write in turn — which is also what made
   * a page's writes as slow as all of them in a row — and a chapter closed
   * mid-page still had every repair on that page made, written, shown, and
   * sent up against whichever workspace the address named by then.
   *
   * The borrowed ones are kept before the model starts on the rest, as they
   * always were: they are the server's already, so a stop after them leaves
   * nothing sent that was not there, and a page shows them without waiting
   * out its inference.
   */
  async function cleanOne (target: ComicPage, index: number, total: number, done: number, run: CleanRun) {
    const scan = target.scan
    // Taken as a local, which is what makes the narrowing hold: a `const`
    // stays narrowed across the awaits below, where `settings.value.model`
    // would widen again at the first of them.
    const model = settings.value.model

    if (!cleanerRuns(model)) return 0
    // Measured here rather than merely required, so that "Clean all pages"
    // cannot silently pass over the pages whose size has not landed yet — see
    // `measured`.
    if (!scan?.hash || !(await measured(target))) return 0

    const blocks = lettering(target)

    if (!blocks.length) return 0

    const say = (message: string, step?: { done: number, total: number }) => {
      progress.value = { page: index + 1, pages: total, message, step, done }
    }

    const source = { file: scan.file, width: scan.width }
    const wanted: { block: Block, region: Region, key: string, edits: MaskEdit[] }[] = []

    let found = 0

    // The cache pass first, so a chapter cleaned before comes back at once
    // rather than a balloon at a time behind a progress bar.
    for (const block of blocks) {
      // Stopped: nothing more is looked up for a page nobody is looking at.
      if (run.signal.aborted) return found

      const region = regionOf(block, scan)
      // The corrections are part of what a patch *is*, so they are read
      // before the key is worked out rather than after — see `patchKey`.
      const edits = (run.chapter && editsFrom(run.chapter, target, block))
        ?? await load(target, block).catch(() => [] as MaskEdit[])
      const key = patchKey({ scan: scan.hash, region, model, edits, source: maskSource() })
      const held = await readPatch(key).catch(() => null)

      if (held) {
        const box = paddedBox(region, scan.width, scan.height, edits)

        show(target.id, block.id, { url: URL.createObjectURL(held), ...boxOf(box, scan), from: region, scan: scan.hash, key })
        found++

        continue
      }

      wanted.push({ block, region, key, edits })
    }

    if (!wanted.length) return found

    /*
     * Somebody else's work, before this machine's — see `borrow`. Cleaning a
     * chapter is by a wide margin the most expensive thing the app does, and
     * the second person on it should not pay the whole bill again.
     */
    const kept = await borrow(target, wanted.map((item) => item.key), run)
      .catch(() => new Map<string, { bytes: Blob, row: RepairRow }>())

    // Stopped while they came down: what arrived is not kept.
    if (run.signal.aborted) return found

    // Written to the disk as though this machine had made them: each is the
    // same repair, filed under the same name, and the next chapter opening must
    // not go asking for it again. In one sweep — see the header.
    const borrowing = new Map<string, Promise<void>>()

    for (let i = wanted.length - 1; i >= 0 && kept.size; i--) {
      const item = wanted[i]!
      const borrowed = kept.get(item.key)

      if (!borrowed) continue

      if (!borrowing.has(item.key)) borrowing.set(item.key, writePatch(item.key, borrowed.bytes))

      show(target.id, item.block.id, {
        url: URL.createObjectURL(borrowed.bytes),
        ...boxOf(borrowed.row.box, scan),
        from: borrowed.row.from,
        scan: scan.hash,
        key: item.key,
        hash: borrowed.row.hash,
      })
      wanted.splice(i, 1)
      found++
    }

    await Promise.all(borrowing.values())

    if (!wanted.length) return found

    say(`Cleaning ${wanted.length} block${wanted.length === 1 ? '' : 's'}…`)

    const made = await cleanPage(
      source,
      wanted.map((item) => item.region),
      say,
      model,
      {
        edits: Object.fromEntries(wanted.map((item, index) => [index, item.edits])),
        parts: Object.fromEntries(wanted.map((item, index) => [index, partsOf(item.block, scan)])),
        outlines: Object.fromEntries(wanted.map((item, index) => [index, outlineOf(item.block, scan)])),
        // The index is into `wanted` as it stands *now* — the cache and the
        // server have already taken their blocks out of it, and the regions
        // handed over came from the same array a line above.
        onSkip: (index, why) => {
          const item = wanted[index]

          if (item) note(target.id, item.block.id, why)
        },
        // Read once for the whole page and sliced per block — see
        // `segmentedPage`, and note the hash is what makes turning back to
        // this page free rather than another inference.
        segment: segmentOver(scan.hash),
        // The run's stop: no balloon is started after it, and the page's
        // repairs are thrown away rather than handed back.
        signal: run.signal,
      },
    )

    // Stopped between the last balloon's seam and here. Nothing of the page
    // is kept — see the header.
    if (run.signal.aborted) return found

    // `cleanPage` drops the regions it could not find lettering in, so the
    // results are matched back by their box rather than by position in the
    // list. The boxes are exact — both sides compute them with `paddedBox`.
    const repaired = new Set<string>()
    const writing = new Map<string, Promise<void>>()

    for (const patch of made) {
      const item = wanted.find((candidate) => {
        const box = paddedBox(candidate.region, scan.width, scan.height, candidate.edits)

        return box.x === patch.x && box.y === patch.y && box.w === patch.w && box.h === patch.h
      })

      if (!item) continue

      if (!writing.has(item.key)) writing.set(item.key, writePatch(item.key, patch.image))

      keepRemotely(target, item.block, item.key, patch.image, item.region, patch).catch(() => {})
      show(target.id, item.block.id, {
        url: URL.createObjectURL(patch.image),
        ...boxOf(patch, scan),
        from: item.region,
        scan: scan.hash,
        key: item.key,
      })
      repaired.add(item.block.id)
      found++
    }

    // And the ones nothing came back for. A block that was asked about and had
    // no lettering left in it is a block whose old repair is a repair of
    // something that is not there any more — see `hide`.
    for (const item of wanted) {
      if (repaired.has(item.block.id)) continue

      hide(target.id, item.block.id)
      withdrawRemotely(item.block)
    }

    await Promise.all(writing.values())

    return found
  }

  async function run (targets: ComicPage[]) {
    // The one gate that has to be here rather than only on `canClean`. A button
    // that greys out covers the presses; this covers everything else that
    // reaches a run — the mask brush, a block that was moved, the auto run —
    // and those are the paths where "no cleaner" would otherwise be discovered
    // as a stack of repairs nobody asked for.
    if (!repairs.value || running.value || !targets.length) return

    /*
     * The run's stop: the chapter closed or replaced under it.
     *
     * The epoch used to be checked between pages only, so the page in hand
     * went on being cleaned — every balloon run, every repair written, shown and
     * sent up — for a chapter that was no longer open. Now the change aborts the
     * run where it stands: no balloon is started after it, no download is kept,
     * and the page in hand keeps nothing (see `cleanOne`). Synchronous, so the
     * stop is in force from the moment the epoch moves, not a tick later.
     */
    const stop = new AbortController()
    const unwatch = watch(epoch, () => stop.abort(), { flush: 'sync' })

    error.value = null
    // The whole list, not the pages about to be done: a report is only ever
    // about the run that produced it, and a reason left over from a page that
    // is no longer being cleaned is a reason nobody can act on.
    skipped.value = []
    progress.value = { page: 1, pages: targets.length, message: 'Starting…', done: 0 }

    try {
      let done = 0

      // Every block's corrections at once, as `restore` reads them. Asked a
      // block at a time through `load`, a cloud workspace's clean was up to
      // three requests per balloon in a row before any inference — and made a
      // mask surface for every balloon nobody had corrected.
      const chapter = await chapterEdits().catch(() => null)
      const workspace = workspaceOf()
      const context: CleanRun = { chapter, workspace, rows: listOnce(workspace, stop.signal), signal: stop.signal }

      for (const [index, target] of targets.entries()) {
        if (stop.signal.aborted) break

        done += await cleanOne(target, index, targets.length, done, context)
      }
    } catch (thrown) {
      // Stopped is not failed — the chapter it was cleaning is gone.
      if (!stop.signal.aborted) error.value = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      unwatch()
      progress.value = null
    }
  }

  /**
   * One balloon, on its own.
   *
   * The unit the brush works in: correct a mask, re-run the block it belongs
   * to, leave the rest of the page alone. Also the way back from a transform
   * — moving a block invalidates its repair, and re-cleaning the whole page
   * to recover one of them is a minute spent on nine balloons that were
   * already right.
   *
   * Runs through the same path as a page, with a list of one, so the cache,
   * the progress line and the epoch guard all behave identically.
   */
  async function cleanBlock (target: ComicPage, block: Block) {
    if (running.value) return

    const scan = target.scan
    const model = settings.value.model

    // The brush's own path into a repair, which does not go through `run` — so
    // "no cleaner" has to be answered here as well or a mask correction would
    // still fetch a model and clean a balloon.
    if (!cleanerRuns(model)) return
    if (!scan?.hash || !(await measured(target))) return

    const started = epoch.value

    error.value = null
    // Only this block's reason, unlike a page run: correcting one balloon is
    // not an answer about the other nine, and wiping their reasons because the
    // brush was put down would empty the report a block at a time.
    unnote(target.id, block.id)
    progress.value = { page: 1, pages: 1, message: 'Cleaning…', done: 0 }

    // Registered only now, beside the `finally` that takes it back out, so a
    // return above cannot leave a stale one behind — see `abandonClean`.
    const slot = blockKey(target.id, block.id)
    const controller = new AbortController()

    repairing.set(slot, controller)

    try {
      const region = regionOf(block, scan)
      const edits = await load(target, block).catch(() => [] as MaskEdit[])
      const key = patchKey({ scan: scan.hash, region, model, edits, source: maskSource() })

      const held = await readPatch(key).catch(() => null)

      if (held) {
        show(target.id, block.id, {
          url: URL.createObjectURL(held),
          ...boxOf(paddedBox(region, scan.width, scan.height, edits), scan),
          from: region,
          scan: scan.hash,
          key,
        })

        return
      }

      const [patch] = await cleanPage(
        { file: scan.file, width: scan.width },
        [region],
        (message, step) => { progress.value = { page: 1, pages: 1, message, step, done: 0 } },
        model,
        {
          edits: { 0: edits },
          parts: { 0: partsOf(block, scan) },
          outlines: { 0: outlineOf(block, scan) },
          onSkip: (_index, why) => note(target.id, block.id, why),
          // The page's mask, not this balloon's: a correction re-cleans one
          // block, and segmenting the page again for each of them is what the
          // hash-keyed cache exists to prevent.
          segment: segmentOver(scan.hash),
          signal: controller.signal,
        },
      )

      // The page turning is not an answer about this block, so its repair
      // stands; nothing coming back *is* one — see `hide`.
      if (epoch.value !== started) return

      // Called off while the model was running: a repair of a mask that has
      // since changed, so neither shown nor filed. The correction that called
      // it off has queued the block again — see `abandonClean`.
      if (controller.signal.aborted) return

      if (!patch) {
        hide(target.id, block.id)
        withdrawRemotely(block)

        return
      }

      await writePatch(key, patch.image)
      keepRemotely(target, block, key, patch.image, region, patch).catch(() => {})
      show(target.id, block.id, {
        url: URL.createObjectURL(patch.image),
        ...boxOf(patch, scan),
        from: region,
        scan: scan.hash,
        key,
      })
    } catch (thrown) {
      // Called off is not a failure — see `abandonClean`.
      if (!controller.signal.aborted) error.value = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      progress.value = null

      if (repairing.get(slot) === controller) repairing.delete(slot)
    }
  }

  /**
   * The same block, once the person has stopped correcting it.
   *
   * What the brush calls. Every stroke pushes the moment out again, so a
   * flurry of corrections is one repair at the end of it rather than one per
   * stroke — see `SETTLE`.
   */
  function cleanBlockSoon (target: ComicPage, block: Block) {
    // A repair already running for this block is of the mask before this
    // correction — call it off rather than wait for it. See `abandonClean`.
    abandonClean(target.id, block.id)

    // `\u0000` rather than the character itself: it cannot appear in either
    // id, which is why it is the separator, but written raw it makes this
    // file binary to grep and every search over it silently finds nothing.
    waiting.add(blockKey(target.id, block.id))

    if (settle) clearTimeout(settle)

    const model = settings.value.model
    const wait = cleanerRuns(model) && repairsAreQuick(model) ? SETTLE_QUICK : SETTLE

    settle = setTimeout(() => { settle = null; drain().catch(() => {}) }, wait)
  }

  /** Everything a correction has invalidated, in turn. */
  async function drain () {
    // A run already going owns the models and the progress line. Wait for it
    // rather than dropping the work, which `cleanBlock` would do silently.
    if (running.value) {
      settle = setTimeout(() => { settle = null; drain().catch(() => {}) }, SETTLE)

      return
    }

    const due = [...waiting]

    waiting.clear()

    for (const key of due) {
      const [pageId, blockId] = key.split('\u0000')
      const target = pages.value.find((candidate) => candidate.id === pageId)
      const block = target?.blocks.find((candidate) => candidate.id === blockId)

      // Gone since the correction was made, which is not an error — a deleted
      // block has nothing to repair.
      if (target && block) await cleanBlock(target, block)
    }
  }

  function cleanCurrent () {
    const target = pages.value[at.value]

    return target ? run([target]) : undefined
  }

  function cleanAll () {
    return run(pages.value.filter((target) => target.scan && target.blocks.length))
  }

  /**
   * Put back whatever the cache already holds, without running anything.
   *
   * Called when a chapter opens. Silent by design: a page nobody has cleaned
   * has no patches, which is not a state worth reporting.
   *
   * It gets one go, from a watcher keyed on the hashes as they land — so
   * everything it needs it has to be able to get for itself by the time it
   * runs. The hash is that watcher's own dependency and the blocks are awaited
   * ahead of it; the page's size is neither, which is what `measured` is for
   * and why it is called rather than checked.
   *
   * The same is true of the settings, which name every repair as surely as the
   * box does — `patchKey` stamps the model and the mask source into it. They
   * come back out of this machine's storage in an idle callback (`remember`),
   * and a chapter can open ahead of that: on a busy page, or in a tab that is
   * not in front. Looked up under the defaults, a chapter cleaned with anything
   * else came back bare. So this waits for them, and takes both once, so a
   * toggle flipped mid-restore cannot look half a page up under each.
   *
   * The settings only put the candidates in order, though. A repair made with
   * any cleaner is put back — see `restoreKeys` for the report that decided it.
   */
  /**
   * Clear out repairs made under superseded mask recipes, once per chapter
   * opened — see `sweepStaleRecipes`. Here rather than on the workspace page
   * because it has to spare what this workspace's server list still names,
   * and this is where that list is read. Not at all for a cloud workspace whose
   * list did not arrive: sparing nothing would delete exactly the files `restore`
   * is about to download again.
   */
  function sweepOnce (opened: number, cloud: boolean, remote: RepairRow[] | null) {
    if (swept === opened || (cloud && !remote)) return

    swept = opened

    sweepStaleRecipes(new Set(remote?.map((row) => row.key))).then((count) => {
      if (count) console.info(`[kemolate] swept ${count} cached repair${count === 1 ? '' : 's'} made under a mask recipe other than ${MASK_RECIPE} that this workspace does not still name.`)
    })
  }

  async function restore () {
    // The epoch this composable was set up with — a `useState`, so the same
    // ref from anywhere. Asking `useComic` for it again here, in a watcher's
    // callback, used to leave a pair of its watchers running for good.
    const opened = epoch.value
    const { begin, step, end } = useOpening()

    await remembered('kemolate:clean')

    const model = settings.value.model
    const source = maskSource()

    // "None" is the reader saying these pages arrive already cleaned, so the
    // repairs on disk are not wanted on them. Not a loss: the files stay, and
    // picking a model again finds every one of them.
    if (!cleanerRuns(model)) return

    // Listed once rather than asked a file at a time. Each block now has six
    // names it could be under, and a chapter nobody has cleaned would otherwise
    // be six misses a balloon.
    const onDisk = new Set(await listPatches())

    // And what the server keeps, for a cloud workspace: the same chapter's
    // cleaning made on another machine, or in this browser before its storage
    // was cleared. See `repairs` in the schema.
    const workspace = workspaceOf()
    const cloud = inCloud()
    const remote = cloud
      ? await $fetch<RepairRow[]>(`/api/workspaces/${workspace}/repairs`).catch(() => null)
      : null

    sweepOnce(opened, cloud, remote)

    if (!onDisk.size && !remote?.length) return

    // Every block's corrections at once, where the workspace has them — see
    // `chapterEdits`, which is the difference between one request and three
    // a balloon.
    const chapter = await chapterEdits().catch(() => null)

    /*
     * The page in front of the reader first, then the rest in order.
     *
     * And every read handed to `inParallel` rather than awaited in turn. A
     * chapter opens with the mask plate segmenting the page on screen — ten
     * seconds of inference across every core, measured on a fifty-page chapter
     * — and while it runs each OPFS read waits a quarter of a second. One after
     * another that was two seconds a page and twenty for the chapter, with the
     * cleaning arriving a page at a time behind it; side by side it is the wait
     * of a few reads. The work was never the cost, the queue was.
     */
    const here = pages.value[at.value]
    const order = here ? [here, ...pages.value.filter((target) => target !== here)] : [...pages.value]
    const reads: (() => Promise<void>)[] = []

    // Repairs this browser holds that the server does not, sent once the page
    // is back — which is how a chapter cleaned before its workspace kept
    // repairs gets them kept. Never waited for.
    const uploads: (() => Promise<void>)[] = []

    // How many of `reads` belong to the page on screen — see the end.
    let mine = 0

    for (const target of order) {
      // Replaced while this ran: these pages are gone, and the run that follows
      // the replacement does the ones that took their place.
      if (epoch.value !== opened) return

      const scan = target.scan

      // A page with nothing on it needs no size worked out for it, so the
      // blocks are asked about before the measuring rather than after: a
      // chapter nobody has read is the common case and this keeps it free.
      if (!scan?.hash || !lettering(target).length) continue
      if (!(await measured(target))) continue

      const hash = scan.hash

      for (const block of lettering(target)) {
        const shown = patches.value[target.id]?.[block.id]

        // A repair already on the page stays — unless it was only shown from
        // the page's record, in which case this is what decides it.
        if (shown && !shown.provisional) continue

        const region = regionOf(block, scan)
        const edits = (chapter && editsFrom(chapter, target, block))
          ?? await load(target, block).catch(() => [] as MaskEdit[])
        const keys = restoreKeys({ scan: hash, region, edits }, model, source)
        const key = keys.find((candidate) => onDisk.has(candidate))
        const pageRow = remote ? pageRowOf(target) : null

        // The server's row under the same recipe, if it keeps one: the same
        // repair, or the same balloon cleaned again on another machine.
        const kept = key ? remote?.find((row) => row.pageId === pageRow && row.key === key) ?? null : null

        // The record was right: nothing to read, it only stops being provisional.
        // Not where the server holds this recipe and the record does not know
        // it holds the same picture — that is decided below, by reading it.
        if (key && shown?.key === key && (!kept || shown.hash === kept.hash)) {
          confirm(target.id, block.id, { ...boxOf(paddedBox(region, scan.width, scan.height, edits), scan), from: region })
          continue
        }

        if (key) {
          if (target === here) mine++

          const box = paddedBox(region, scan.width, scan.height, edits)

          reads.push(async () => {
            const held = await readPatch(key).catch(() => null)

            // Checked again: the block may have been cleaned, or the chapter
            // replaced, while this was reading.
            step('cleaning')

            if (!held || epoch.value !== opened) return

            let picture: Blob = held
            let known: string | undefined

            /*
             * The same recipe on this disk and on the server, and possibly not
             * the same picture: a recipe names the inputs, not the pixels, so
             * the balloon cleaned again on another machine is filed under the
             * name this disk already has. The copy on disk used to win every
             * time, and a repair made again elsewhere never arrived here. Now
             * the newer of the two does — the server's is fetched and kept, or
             * this one is sent up to replace it.
             */
            if (kept) {
              const ours = await hashBytes(held)

              if (ours === kept.hash) {
                known = ours
              } else if (kept.createdAt * 1000 > (held instanceof File ? held.lastModified : 0)) {
                const fresh = await $fetch<Blob>(`/api/workspaces/${workspace}/repairs/${kept.hash}`, { responseType: 'blob' })
                  .catch(() => null)

                if (fresh && epoch.value === opened) {
                  await writePatch(key, fresh)
                  picture = fresh
                  known = kept.hash
                }
              } else {
                uploads.push(() => keepRemotely(target, block, key, held, region, box))
              }
            } else if (remote) {
              uploads.push(() => keepRemotely(target, block, key, held, region, box))
            }

            if (patches.value[target.id]?.[block.id] && !patches.value[target.id]?.[block.id]?.provisional) return

            show(target.id, block.id, {
              url: URL.createObjectURL(picture),
              ...boxOf(box, scan),
              from: region,
              scan: hash,
              key,
              ...(known ? { hash: known } : {}),
            })
          })

          continue
        }

        // Not on this disk: the server's, by recipe or else the newest made for
        // this block — see `repairFor`, which is what finds a repair again after
        // its block has moved.
        const row = remote && pageRow
          ? repairFor(remote.filter((candidate) => candidate.pageId === pageRow), keys, rowOf(block))
          : null

        if (row && shown?.key === row.key) {
          confirm(target.id, block.id, { ...boxOf(row.box, scan), from: row.from })
          continue
        }

        // Nothing for this block any more — so a repair shown from the record
        // is one the page no longer has, and comes down. But only on an answer
        // that is final: a cloud workspace whose list did not arrive, or whose
        // page has no server row *yet* (the chain runs this before the pages
        // are matched up, then again after), has not said "no repair", it has
        // said nothing. Taking the record's repairs down on that showed the
        // printed lettering for a second and then put the same repairs back.
        if (!row) {
          const final = !cloud || (remote !== null && pageRow !== null)

          if (shown?.provisional && final) hide(target.id, block.id)

          continue
        }

        if (target === here) mine++

        // Already on this disk under the row's recipe — fetched on an earlier
        // visit, or made here under settings that no longer name it first — is
        // read rather than downloaded again. Every open used to fetch these.
        const local = onDisk.has(row.key)

        reads.push(async () => {
          const bytes = local
            ? await readPatch(row.key).catch(() => null)
            : await $fetch<Blob>(`/api/workspaces/${workspace}/repairs/${row.hash}`, { responseType: 'blob' })
                .catch(() => null)

          step('cleaning')

          if (!bytes || epoch.value !== opened) return
          if (patches.value[target.id]?.[block.id] && !patches.value[target.id]?.[block.id]?.provisional) return

          // Into this browser's own store as well, under the recipe it was made
          // from, so the next visit reads it from disk.
          if (!local) await writePatch(row.key, bytes)

          show(target.id, block.id, {
            url: URL.createObjectURL(bytes),
            ...boxOf(row.box, scan),
            from: row.from,
            scan: hash,
            key: row.key,
            hash: row.hash,
          })
        })
      }
    }

    // The page on screen on its own first. Handed to the pool beside fifteen
    // others its reads came back in the same batch as theirs, so the balloons
    // somebody is looking at waited on the ones they are not.
    if (reads.length) {
      // Counted in balloons, which is what the reads are — see `useOpening`.
      begin('cleaning', reads.length)

      try {
        await inParallel(reads.slice(0, mine), 16)
        await inParallel(reads.slice(mine), 16)
      } finally {
        end('cleaning')
      }
    }

    // And what nothing asked for by name, for the blocks still bare.
    await adoptOrphans(onDisk, opened)

    // One at a time and not awaited: nothing on screen is waiting for these.
    if (uploads.length && keepsRepairs()) {
      ;(async () => {
        for (const upload of uploads) await upload()
      })().catch(() => {})
    }
  }

  /**
   * Repairs on this disk nothing asks for by name any more, put back on the
   * blocks they were made for.
   *
   * A repair is named by the box its block had when it was cleaned, so a block
   * nudged since asks for a name nobody made, and its repair sat on the disk
   * unfound — and, never found, was never sent to the server either, so no
   * other machine had it. The server's rows solve this for what they hold (see
   * `repairFor`); this is the same thing for what only this disk holds.
   *
   * Conservative on purpose, because showing one balloon's repair on another's
   * block is worse than showing none: the same scan, the model, mask recipe and
   * mask source that would be used now, made without corrections (their box
   * cannot be read back out of a name — see `patchMade`), at least 60% the same
   * box as the block, and not shown for anything else on the page. It is laid
   * where it was cut from, as every repair is (`patchStands`), and on a cloud
   * workspace sent up under the block, so the next visit finds it by its row.
   */
  async function adoptOrphans (onDisk: ReadonlySet<string>, opened: number) {
    const model = settings.value.model
    const segmenter = settings.value.segmenter

    if (!cleanerRuns(model)) return

    const overlap = (a: Region, b: Region) => {
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      const shared = w > 0 && h > 0 ? w * h : 0

      return shared / (a.w * a.h + b.w * b.h - shared || 1)
    }

    for (const target of pages.value) {
      if (epoch.value !== opened) return

      const scan = target.scan

      if (!scan?.hash || !scan.width || !scan.height) continue

      const shown = patches.value[target.id] ?? {}
      const bare = lettering(target).filter((block) => !shown[block.id])

      if (!bare.length) continue

      const taken = new Set(Object.values(shown).map((patch) => patch.key))
      const prefix = scan.hash.slice(0, 16)
      const orphans = [...onDisk].flatMap((key) => {
        if (taken.has(key) || !key.startsWith(prefix)) return []

        const made = patchMade(key)

        return made && made.model === model && made.recipe === MASK_RECIPE && made.segmenter === segmenter && !made.edited
          ? [{ key, region: made.region }]
          : []
      })

      if (!orphans.length) continue

      for (const block of bare) {
        const region = regionOf(block, scan)

        let best: { key: string, region: Region, share: number } | null = null

        for (const orphan of orphans) {
          const share = overlap(region, orphan.region)

          if (!taken.has(orphan.key) && share >= 0.6 && (!best || share > best.share)) best = { ...orphan, share }
        }

        if (!best) continue

        const held = await readPatch(best.key).catch(() => null)

        if (!held || epoch.value !== opened || patches.value[target.id]?.[block.id]) continue

        taken.add(best.key)

        const box = paddedBox(best.region, scan.width, scan.height, [])

        show(target.id, block.id, {
          url: URL.createObjectURL(held),
          ...boxOf(box, scan),
          from: best.region,
          scan: scan.hash,
          key: best.key,
        })

        keepRemotely(target, block, best.key, held, best.region, box).catch(() => {})
      }
    }
  }

  /**
   * Bring one page's cleaning up to date with the server — what a `repairs`
   * notice asks for, when somebody kept a repair or took one back.
   *
   * Each block's repair is chosen exactly as `restore` chooses it (`repairFor`:
   * the recipe this browser's settings and the block's corrections name, then
   * the newest), so a notice can never show something a reload would not. What
   * it adds is the comparison: a repair whose hash is the server's is already
   * right and is left alone, and one whose hash differs was made again
   * somewhere else — the same balloon cleaned again under the same recipe,
   * which used to stay the old picture here until the disk was cleared. A
   * repair only this browser holds (no hash) is left alone too, since the
   * server has said nothing about it. One the server held and no longer does
   * was taken back, and comes down.
   *
   * "Newest wins" was tried first and is wrong: undo a mask correction and the
   * block goes back to the uncorrected recipe, while the newest row is still
   * the corrected one — every notice about the page would have put it back.
   */
  async function refreshRepairs (pageRow: number) {
    const workspace = workspaceOf()
    const model = settings.value.model

    if (!inCloud() || !workspace || !cleanerRuns(model)) return

    const target = pages.value.find((candidate) => pageRowOf(candidate) === pageRow)
    const scan = target?.scan

    if (!target || !scan?.hash || !(await measured(target))) return

    const [rows, chapter] = await Promise.all([
      $fetch<RepairRow[]>(`/api/workspaces/${workspace}/repairs`).catch(() => null),
      chapterEdits().catch(() => null),
    ])

    if (!rows || target.scan?.hash !== scan.hash) return

    const own = rows.filter((row) => row.pageId === pageRow)
    const source = maskSource()

    for (const block of lettering(target)) {
      const shown = patches.value[target.id]?.[block.id]
      const region = regionOf(block, scan)
      const edits = (chapter && editsFrom(chapter, target, block))
        ?? await load(target, block).catch(() => [] as MaskEdit[])
      const row = repairFor(own, restoreKeys({ scan: scan.hash, region, edits }, model, source), rowOf(block))

      if (!row) {
        if (shown?.hash) hide(target.id, block.id)

        continue
      }

      if (shown?.hash === row.hash) continue

      // This browser's own repair under the recipe the server now names, not
      // yet known to be the server's: the same picture, very likely — it was
      // probably this browser that sent it — so it is checked, not fetched.
      if (shown && !shown.hash && shown.key === row.key) {
        const held = await readPatch(row.key).catch(() => null)

        if (held && await hashBytes(held) === row.hash) {
          if (patches.value[target.id]?.[block.id] === shown) patches.value[target.id] = { ...patches.value[target.id], [block.id]: { ...shown, hash: row.hash } }

          continue
        }
      }

      const bytes = await $fetch<Blob>(`/api/workspaces/${workspace}/repairs/${row.hash}`, { responseType: 'blob' }).catch(() => null)

      // Checked again: the page may have been re-opened, or the block cleaned
      // here, while this was fetching.
      if (!bytes || target.scan?.hash !== scan.hash || patches.value[target.id]?.[block.id] !== shown) continue

      await writePatch(row.key, bytes)

      show(target.id, block.id, {
        url: URL.createObjectURL(bytes),
        ...boxOf(row.box, scan),
        from: row.from,
        scan: scan.hash,
        key: row.key,
        hash: row.hash,
      })
    }

    keepShown(target).catch(() => {})
  }

  /** The patches drawn on one page, for the canvas. */
  const on = (pageId: string) => computed(() => patches.value[pageId] ?? {})

  /**
   * The patch a block should actually be shown, or nothing.
   *
   * See `patchStands`, which is the whole of the rule and is out at the top of
   * the file so it can be tested without a page around it.
   */
  function patchFor (target: ComicPage, block: Block): PagePatch | null {
    // Desktop: none for a block called garbage or hidden — see `drawsRepair`.
    if (!drawsRepair(block)) return null

    const patch = patches.value[target.id]?.[block.id]

    return patchStands(patch, target.scan) ? patch : null
  }

  return {
    settings,
    progress,
    error,
    skipped,
    running,
    repairs,
    canClean,
    patches,
    on,
    patchFor,
    cleanBlock,
    cleanBlockSoon,
    cleanCurrent,
    cleanAll,
    restore,
    refreshRepairs,
    showKept,
    keepShown,
    forget,
  }
}
