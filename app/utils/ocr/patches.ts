/**
 * Where a cleaned balloon's pixels live between visits.
 *
 * A patch is the artwork with one block's lettering painted out — see
 * `clean.ts` for how it is made. It is *derived*: given the scan, the box,
 * the mask and the model, it can always be made again. So it is cached
 * rather than stored, in the origin's private filesystem beside the models
 * and the chapters, and losing it costs a second of inference rather than
 * anybody's work.
 *
 * ## Keyed by what it is, not by whose it is
 *
 * The key is a hash of everything the patch was made from. Not the block's
 * id — a block read again gets a new id, and a patch filed under the old one
 * would be orphaned while an identical piece of work was done over. Content
 * addressing makes that impossible: the same balloon, the same mask and the
 * same model come to the same key whenever they are asked for, so re-reading
 * a page costs nothing to re-clean.
 *
 * It also makes invalidation something that cannot be forgotten. There is no
 * "clear the cache when the mask changes" step to omit, because a changed
 * mask is a different key and the old patch simply stops being asked for.
 *
 * ## What the key does *not* promise
 *
 * It names the inputs, not the pixels. On one machine the pixels are stable:
 * these inpainters sample nothing, the backend is pinned to WebAssembly (see
 * `onnx.ts`), and running the same block twice was measured byte-identical
 * for all three models. Across machines it is only *equivalent*, not
 * identical — canvas resampling differs between browsers and platforms, and
 * so does the PNG encoder, so two people cleaning the same balloon get the
 * same picture and different bytes.
 *
 * Which is harmless while patches stay on the machine that made them, and
 * would stop being harmless the day they are passed between peers by this
 * key. That is the day the key has to name the *output* — a hash of the
 * bytes, as `surfaces.hash` already does for a baked plate — with this one
 * demoted to a local lookup.
 *
 * ## The version in the key
 *
 * `MASK_RECIPE` is stamped into every key. The automatic half of a mask is
 * recomputed rather than stored — see the note in `clean.ts` — so changing
 * the threshold or the dilation changes what every existing patch *would*
 * be. Without the version those patches would go on being served under keys
 * that no longer describe them. With it, the old ones fall out of use on
 * their own and nothing has to be hunted down.
 */
// By hand rather than auto-imported, so a dev server already running picks up
// helpers it has not seen.
import { opfsDir, opfsNames, opfsRead, opfsUsable, opfsWrite } from '~/utils/opfs'

/**
 * Bumped whenever the same inputs would now produce a different mask — the
 * threshold rule, the dilation, the tile bounds, or the order corrections are
 * composited in — and, as 6 and 10 record, whenever the same mask would now
 * produce a different repair. Not for a change to the inpainter, which is
 * already named in the key.
 *
 * 2 — corrections replay in the order they were drawn. Under 1 every wipe was
 * subtracted after every addition, so a patch made for a block that had both
 * is a repair of a mask nobody would get again.
 *
 * 3 — an addition widens the crop to cover itself. Under 2 the crop came from
 * the block alone, so a patch for a block with a stroke past the margin is a
 * repair of the part that happened to fit.
 *
 * 4 — never shipped. A correction was laid with the *paint* brush's falloff,
 * which fades inward from the radius: at low hardness only the middle half of
 * a stroke crossed the threshold, so an addition marked less than it showed
 * and a wipe left the outer half of its own sweep still masked.
 *
 * 5 — a correction is laid with the brush's curve centred on the nominal
 * radius (`maskCore`), so the half-coverage line — the mask's edge, once it is
 * thresholded — is the brush's width at every hardness, as it was under 3.
 * What changed against 3 is the shape between: one smooth falloff instead of a
 * core and two flat skirts, and a skirt reaching half a radius rather than a
 * whole one. Every mask with a soft stroke in it is a different mask, so every
 * patch made from one is a repair of something nobody would get again.
 *
 * 6 — the repair is stored at the size of the region it replaces rather than at
 * the model's working size. Not a change to the mask, and counted here anyway:
 * this number is what says two patches are not the same picture, and one made
 * under 5 sits on a different pixel grid from the page. Kept, it would be
 * resampled onto the page for ever — which is the seam this whole change is
 * about — and it would fail the size check a peer's copy is proved by.
 *
 * 7 — a block that is a joined balloon is thresholded a column at a time
 * rather than all at once. One Otsu split across a stack of lines is decided
 * by whichever lines have the most contrast, and the faint ones at the bottom
 * of it read as background: they contributed no ink, so nothing was painted
 * out and they survived on the cleaned plate looking untouched. Every balloon
 * with more than one child now yields a different mask, so every patch made
 * from one is a repair nobody would get again — which is exactly what this
 * number is for. Without the bump the old repair keeps its key and is served
 * from the cache for ever, and the fix is invisible on the pages that have it.
 *
 * 8 — which side of the threshold is the lettering is settled across the whole
 * block instead of within each column. 7 asked it per column, and a box drawn
 * tight around a line of extra bold lettering is more than half ink, so the
 * "lettering is the smaller side" rule chose the paper: the mask came back
 * inverted, the background was painted out and the words left standing on it.
 * Bold lines and titles on dark banners are the ones it happened to, so 7's
 * patches for them are repairs of the wrong half of the picture.
 *
 * 9 — that side is read off the block's whole box rather than off its columns
 * added together. 8 asked the columns, and five tight boxes hold no more paper
 * between them than one does, so a balloon set in bold throughout flipped
 * exactly as it had before and 8 changed nothing for it.
 *
 * 10 — a block whose surrounding artwork is all one colour is filled with that
 * colour instead of being inpainted. Not a change to the mask either, and
 * counted here for the same reason 6 was: this number is what says two patches
 * are not the same picture, and a block cleaned under 9 holds a repair the
 * model invented. Extra bold glyphs on blank paper are half the crop, so the
 * hole handed over is enormous and what comes back is a plausible smear —
 * measured on page 4 of Eclipse 2 at mean luminance 216 with 15% of the block
 * still near-black, where the paper it should be is 255 and none. Without the
 * bump that smear keeps its key and is served for ever, and the fix is
 * invisible on exactly the pages that show the problem.
 *
 * 11 — two changes to what a repair is a picture of, counted once. A turned
 * block is cut as the rectangle around its turned outline and its mask kept
 * inside that outline, where 10 cut the unturned box and left the tops and
 * bottoms of tilted letters on the page. And the repair is blended over the
 * scan at the page's own size, where 10 blended at the model's size and then
 * resampled the whole rectangle — which blurred the screentone outside the
 * mask into a visible rectangle (65% of the unmasked pixels changed on the
 * phone screen of Business trip grooming 2, page 7). Kept under 10, those
 * repairs would be served from the cache for ever and neither fix would show.
 *
 * 12 — a repair is transparent outside its mask, where 11 was an opaque
 * rectangle carrying the scan's own pixels there. Turned blocks overlap, and a
 * neighbour's repair drawn over a cleaned one put the lettering back: on that
 * same phone screen the big block cleaned all three messages and the two
 * beside it restored "죽을 것" and "사랑해". An 11 is a correct picture of the
 * wrong thing, so it has to fall out of use.
 *
 * 13 — a turned block's mask may reach `OUTLINE_REACH` past its outline
 * rather than stopping at it. The exact clip in 11 undid the mask's growth
 * wherever a glyph touched its box, and since nearly every block carries a
 * small detector angle, LaMa redrew stroke ends as dark bars across whole
 * chapters. A 12 made that way is a picture of the wrong mask.
 *
 * The threshold is in the recipe as well as the behaviour: `FLAT_TOLERANCE`
 * and `FLAT_SHARE` in `clean.ts` decide *which* blocks are filled, so moving
 * either changes what a patch is a picture of and needs this number moved with
 * it. What each direction costs is written on the constants.
 *
 * ## Why the mask's *source* is not a version
 *
 * The learned segmenter (`mask.ts`, `segment.ts`) is a second answer to the
 * same question, not a newer one, and it is behind a toggle somebody flips
 * back and forth. A version only ever invalidates the past: bump it and every
 * old patch falls out of use, which is right when a rule changed and there is
 * no going back to the old one. Here there is. Both masks are current, patches
 * made from them sit side by side on the same disk, and the same block with
 * the same corrections legitimately has two different repairs.
 *
 * So the source belongs in the key, as `PatchKey.source`. Left out — bumping
 * this number and calling it done — flipping the toggle would serve the patch
 * made the other way, from a cache that is behaving exactly as designed, and
 * the switch would appear to do nothing at all.
 */
export const MASK_RECIPE = 13

const ROOT = 'patches'

/** What a patch was made from, and therefore what it is called. */
export interface PatchKey {
  /** The scan's content hash — the page's real identity. */
  scan: string
  /** The block's box in page pixels, rounded: a sub-pixel nudge is the same patch. */
  region: Region
  /** Which inpainter drew it. */
  // `InpainterModel`, not `Inpainter`: a patch is a thing a model made, so a
  // key naming `none` would be a name for a repair that cannot exist.
  model: InpainterModel
  /**
   * The corrections the mask was drawn with — see `fingerprint`.
   *
   * In the key because they change the mask, and a patch is a picture of a
   * mask. Left out, a balloon corrected by hand would go on being served the
   * patch made before the correction, and the brush would appear to do
   * nothing at all.
   */
  edits?: MaskEdit[]
  /**
   * Which answer to "where is the lettering" the mask came from — the
   * threshold, or the learned segmenter.
   *
   * In the key because the two are both current and both reachable: the
   * toggle flips, and the same balloon has a repair of each on disk. See the
   * note above `MASK_RECIPE` for why this is not a version bump.
   *
   * It names what was *asked for* rather than what was used, which matters
   * for the one block in a page where the segmenter found nothing and the
   * threshold answered instead. That is not a hole: the fallback is decided
   * from the same page, the same model and the same box every time, so a
   * segmenter key still names one repair and only one.
   *
   * Absent is the threshold, so every key written before this existed still
   * spells the same, and a chapter cleaned yesterday is not re-cleaned today.
   */
  source?: MaskSource
}

/**
 * A short, stable name for a set of corrections.
 *
 * Not a cryptographic digest: this only has to change when the strokes do,
 * and collisions cost a stale patch rather than anything dangerous. Points
 * are rounded on the way in for the same reason the box is — a stroke
 * replayed through a float is the same stroke.
 */
function fingerprint (edits: MaskEdit[]): string {
  if (!edits.length) return ''

  const text = edits
    .map((edit) => `${edit.kind}:${Math.round(edit.size)}:${Math.round(edit.hardness * 100)}:${edit.points.map((v) => Math.round(v)).join(',')}`)
    .join(';')

  let hash = 2166136261

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  return `-e${(hash >>> 0).toString(36)}`
}

/**
 * The name a patch is filed under.
 *
 * A plain string rather than a digest: it is already short, it is already
 * unique, and a name you can read is a name you can debug. The box is
 * rounded because a box that moved by a third of a pixel is the same
 * balloon, and re-cleaning it would be work nobody asked for.
 */
export function patchKey ({ scan, region, model, edits = [], source = 'threshold' }: PatchKey): string {
  const box = [region.x, region.y, region.w, region.h].map((value) => Math.round(value)).join('-')

  // The threshold spells nothing, so every key written before there was a
  // second mask still names the file it named then.
  const from = source === 'segmenter' ? '-seg' : ''

  return `${scan.slice(0, 16)}-${box}-${model}-m${MASK_RECIPE}${from}${fingerprint(edits)}`
}

/**
 * What a key says it was made from, read back out of it — the other direction
 * of `patchKey`. Null for anything that is not a key this app writes.
 *
 * `edited` is whether mask corrections went into it: their fingerprint is a
 * digest, so the corrections themselves cannot be read back, and neither can
 * the padded box they grew — a caller that has to place the repair from its
 * name alone can only do so for one made without any.
 */
export function patchMade (key: string): { scan: string, region: Region, model: string, recipe: number, segmenter: boolean, edited: boolean } | null {
  const found = /^([0-9a-f]{16})-(\d+)-(\d+)-(\d+)-(\d+)-([a-z]+)-m(\d+)(-seg)?(-e[0-9a-z]+)?$/.exec(key)

  if (!found) return null

  const [, scan, x, y, w, h, model, recipe, segmenter, edited] = found

  return {
    scan: scan!,
    region: { x: Number(x), y: Number(y), w: Number(w), h: Number(h) },
    model: model!,
    recipe: Number(recipe),
    segmenter: Boolean(segmenter),
    edited: Boolean(edited),
  }
}

export const readPatch = (key: string): Promise<Blob | null> => opfsRead(ROOT, `${key}.png`)

// A cache that cannot be written costs the next visit an inference, not this
// one a failure — which is why `opfsWrite` says nothing.
export async function writePatch (key: string, image: Blob): Promise<void> {
  await opfsWrite(ROOT, `${key}.png`, image)
}

/**
 * Which scan a patch is a repair of, read back out of its name.
 *
 * The key opens with the first sixteen characters of the scan's hash, and this
 * is the one thing anybody needs to read back out of it: a browser offering its
 * repairs to a workspace has to offer only the ones about *that* workspace's
 * pages. Without it the alternative is announcing every patch on the disk,
 * which tells everyone in one chapter the hash prefixes of every other chapter
 * this browser has ever cleaned.
 */
export function patchScan (key: string): string {
  return key.slice(0, key.indexOf('-'))
}

/**
 * Every patch this browser is holding, by key.
 *
 * The names alone — the files are not opened. Announcing what can be served
 * costs a directory listing, and reading a repair costs nothing until somebody
 * actually asks for one, which is the same bargain the page inventory makes
 * with its file handles.
 */
export async function listPatches (): Promise<string[]> {
  // A listing that fails is a listing of nothing: this browser seeds no repairs
  // this time round, and everybody still cleans for themselves.
  return (await opfsNames(ROOT)).filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -4))
}

/**
 * Which mask recipe a patch was made under, read back out of its name.
 *
 * The key names the recipe as a whole segment of its own — `patchKey` composes
 * it as `-m${MASK_RECIPE}-` between the inpainter and whatever follows — so this
 * splits on the same hyphens rather than searching the string. A substring check
 * would read a key under recipe 1 as a key under 10 the moment the number gained
 * a digit, which it did today, and the cost of that mistake is a deletion rather
 * than an error.
 *
 * Null for anything it cannot read one out of: a name written by some other
 * version of this app, or a file that is not a patch at all. Nothing else in the
 * key can be mistaken for the recipe — the scan prefix is sixteen characters of
 * hex, the box is bare digits, the models are named in words, the mask source
 * spells `seg` and a fingerprint always opens with `e` — but where a name
 * somehow offers two, this refuses rather than picks, because the only caller is
 * deciding whether to delete.
 */
export function patchRecipe (key: string): number | null {
  const found = key.split('-').filter((part) => /^m\d+$/.test(part))

  if (found.length !== 1) return null

  return Number(found[0]!.slice(1))
}

/**
 * Whether a cached repair is one nothing will ever ask for again.
 *
 * The narrow, library-free kind of cache pruning, and the only kind there is. A
 * sweep of everything the open chapter does not use was written once and never
 * called, and rightly: a patch is reachable from any workspace holding that
 * scan and this file knows about one chapter at most — so a sweep driven by the
 * open chapter would have two workspaces delete each other's repairs every
 * time the reader walked between them.
 *
 * A superseded recipe carries no such doubt. The cleaner only ever composes a
 * key with the *current* `MASK_RECIPE` in it, so a file under any other number
 * is not merely unreferenced by the chapter in front of us — it is unaskable, by
 * any chapter, in any workspace, for as long as the number stays where it is.
 * And the number only ever goes up: see the log above `MASK_RECIPE`, where each
 * entry records a change that made every older repair a picture of something
 * nobody would get again.
 *
 * A name it cannot read a recipe out of is left alone. Unreadable is not the
 * same as superseded, and this directory is not so exclusively ours that
 * deleting on a guess is free.
 */
export function patchSuperseded (key: string): boolean {
  const recipe = patchRecipe(key)

  return recipe !== null && recipe !== MASK_RECIPE
}

/**
 * Throw away every repair made under a mask recipe that has been left behind.
 *
 * The sweep that needs no argument, and the reason is `patchSuperseded` above:
 * this is decided from the name alone, so it can run on a chapter opening
 * without knowing what any other chapter is holding. It reclaims the most, too —
 * the recipe moved 6 → 10 in one day, and every patch from before that is dead
 * weight on the disk.
 *
 * Except what `keep` names, and that exception is the one place "unaskable" is
 * wrong. A cloud workspace's server list still names repairs made under older
 * recipes — `repairFor` puts back the newest one a block has, whatever it was
 * made with — and `restore` fetches each by that name and files it here. Swept
 * on every open, they were downloaded again on every open: six of nine
 * balloons on a page of Business trip grooming 2, arriving a second behind the
 * rest. So the caller passes the keys its workspace's server list names.
 *
 * Best-effort throughout. A sweep that cannot run costs disk, not a reading, so
 * every failure here is swallowed and the count comes back as however far it
 * got.
 */
export async function sweepStaleRecipes (keep: ReadonlySet<string> = new Set()): Promise<number> {
  if (!opfsUsable()) return 0

  const dir = await opfsDir(ROOT).catch(() => null)

  if (!dir) return 0

  let swept = 0

  try {
    // Listed in full before anything is removed. Removing entries while
    // iterating the directory's own handle is asking a live iterator about a
    // directory that is changing underneath it.
    const stale = (await opfsNames(ROOT))
      .filter((name) => name.endsWith('.png'))
      .filter((name) => patchSuperseded(name.slice(0, -4)) && !keep.has(name.slice(0, -4)))

    for (const name of stale) {
      await dir.removeEntry(name).catch(() => {})
      swept++
    }
  } catch {
    // Nothing to report: files left behind are unreachable, not wrong, and the
    // next chapter opened will find them again.
  }

  return swept
}
