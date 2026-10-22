/**
 * What size the auto-fitted lines actually came out at.
 *
 * "Auto" used to mean a guess — `estimateSize`, worked out from the character
 * count — and a guess is not good enough to letter with: it was setting Japanese
 * half again too large and running seven balloons out of nine off the bottom of
 * their boxes. So Auto measures now. The guess survives only as the number the
 * Lettering panel shows before a measurement exists; the board no longer draws
 * with it, because drawing it for a frame and then correcting it was the
 * lettering visibly jumping on every open — see `fitOf`.
 *
 * Measuring cannot happen where the drawing happens. Reading `scrollHeight`
 * forces the browser to lay the page out, and a render function that does that
 * for every block on every frame is a render function that fights itself. So the
 * sizes are worked out here, after a change, into a map the canvas and the panel
 * both read — one derivation again, so the size the panel reports is the size
 * the page is set in.
 *
 * The alternative — measuring inside the canvas and letting the panel guess —
 * is the same disagreement this codebase keeps having to fix.
 */
import type { LetterFit } from '#shared/utils/lettering'
import type { EffectScope, Ref } from 'vue'
import type { ComicPage } from '~/composables/useComic'

// By hand, so a dev server already running picks up exports it has not seen.
import { shapeFor, shapeOutline, standardApplies } from '#shared/utils/lettering'
import { useLetteringStandard } from '~/composables/useLetteringStandard'
import { HYPHENATION, hyphenationReady } from '~/utils/hyphens'
import { fitAt, fitSize, fitStandard } from '~/utils/lettering'

/**
 * What a block's fit depends on. Anything else changing cannot alter it.
 *
 * The box is the *lettering frame's* — `letterBoxOf`, not the block's own — and
 * that distinction is the whole of what this composable had to learn. A block's
 * box says where the original lettering was found and is what the repair under
 * it was cut from; the room a translation has is whatever frame the letterer
 * gave it. Fitting English into the Japanese box it replaced is exactly the
 * thing widening a balloon is meant to stop.
 */
function keyOf (
  block: Block,
  box: LetterBox,
  style: Lettering,
  family: string,
  vertical: boolean,
  scan: { w: number, h: number },
  plan: { shape: string, standard: number | null, lang: string, breaks: boolean },
): string {
  return [
    block.translation || block.source,
    box.w, box.h,
    style.line, style.spacing, style.bold, style.italic, family, vertical,
    scan.w, scan.h,
    // What the fit is aiming at, not only what it measures: the shape the lines
    // wrap into (and where in it they sit), the standard size it is held to,
    // and the language its hyphenation looks words up in.
    plan.shape, style.anchor, plan.standard ?? '', plan.lang,
    // Desktop: whether the language's breaks were in hand — a fit measured
    // before they arrived could not hyphenate, and is measured again once they do.
    plan.breaks ? HYPHENATION : '',
  ].join('|')
}

/**
 * Sizes measured before, by what they were measured from — kept in this
 * browser between visits.
 *
 * Every open of a chapter began with every size forgotten: the balloons drew at
 * `estimateSize`'s guess and then jumped to the measured size a frame or two
 * later, and every page turn did the same, because the store only ever held the
 * page on screen. Recorded opening Business trip grooming 2, the guess was up to
 * a fifth too large (30.4px against 25.6px) and the lettering visibly shrank.
 *
 * Keyed by `keyOf` — the words, the frame, the style, the face and the page's
 * size — so a size is only ever reused for exactly what it was measured from,
 * in any workspace. Measured only in the real face (see `loadFace`), which is
 * why the key no longer needs to say which faces had loaded. The last `KEEP`
 * are held, oldest out first.
 */
const STORE = 'lettering-fits'

/**
 * Which measurements the kept sizes are, and the lever for throwing them away.
 *
 * A size is keyed by what it was measured from — the font *stack* among it —
 * but not by the font files behind the names. Change what a face draws without
 * changing its name (a new file, a `size-adjust` in `fonts.css`) and every size
 * kept for it is a size for letters that are no longer there: an automatic
 * balloon comes back set for the old face, too big or too small. So bump this
 * whenever a face's metrics change; the next visit reads nothing kept and
 * measures everything once. 2: Anime Ace 3 drawn at 120% (2026-09-28).
 * 3: the size range grew with the page (`letteringRange`), so a size kept from
 * before may be one that stopped at the old ceiling of 70 (2026-09-28).
 * 4: ink stopped counting the space a line wraps at (`inkOf`), which had
 * stopped some balloons growing at a fraction of their room (2026-09-30).
 * 5: a fit is a `LetterFit` rather than a bare size — shapes, the standard size
 * and its squeeze (2026-09-30).
 * 6: no emergency word breaks (`LETTERING_WRAP`), so a fit that only held by
 * splitting a word with no hyphen no longer does (2026-09-30).
 * 7 (desktop): Anime Ace 3 is the installed face now (`local()` in
 * `fonts.css`); every fit before was measured in the Shantell Sans the stack fell
 * back to while the files were missing, under Anime Ace's name (2026-10-21).
 * 8 (desktop): a shape is measured a little narrower than it is drawn
 * (`SHAPE_SLACK`), so a shaped fit kept from before may be one whose last word
 * the board wraps out of the frame (2026-10-22).
 * 9 (desktop): long words are broken with soft hyphens (`utils/hyphens`), so
 * a fit that shrank a balloon for one unbroken word may now be larger (2026-10-22).
 * 10 (desktop): `SHAPE_SLACK` 4% → 1%; a shaped fit's pad was worked out for the
 * probe's taller wrap and set the words high in the oval (2026-10-22).
 * 11 (desktop): a shaped line's words are placed by search, and a size only goes
 * if they sit where the anchor says (`tryFit`, `ANCHOR_SLACK`) (2026-10-22).
 */
const FITS_VERSION = 11
const KEEP = 4000

const remembered = new Map<string, LetterFit>()

let reading: Promise<void> | null = null
let writing: ReturnType<typeof setTimeout> | null = null

function remember (key: string, fit: LetterFit) {
  remembered.delete(key)
  remembered.set(key, fit)

  while (remembered.size > KEEP) {
    const [oldest] = remembered.keys()

    if (oldest === undefined) break

    remembered.delete(oldest)
  }

  if (writing) clearTimeout(writing)

  writing = setTimeout(() => {
    writing = null
    idb.set(STORE, { v: FITS_VERSION, sizes: [...remembered] }).catch(() => {})
  }, 1000)
}

/** The scope the fits' upkeep lives in — see `pruneFits`. */
let upkeep: EffectScope | null = null

/**
 * Forget the fits of blocks that are on no page.
 *
 * Both maps are keyed by block id and were only ever added to, so a session
 * carried every block it had ever fitted: every reading of every page it had
 * read again, every chapter it had opened before this one, in whatever
 * workspace. None of those can be drawn, and every pass of `refit` used to copy
 * the lot.
 *
 * Pruned when the chapter's set of blocks changes — a page read again, a page
 * added or taken away, a block made or deleted, a row given its id, another
 * chapter opened — and never on a keystroke or a drag, which change what a
 * block says or where it is and not which blocks there are. Nothing measured is
 * lost by it: `remembered` is keyed by what a size was measured from rather
 * than by whose it was, so a block that comes back is fitted from there at once.
 */
function pruneFits (fits: Ref<Record<string, LetterFit>>, keys: Ref<Record<string, string>>) {
  const { pages } = useComic()

  watch(
    () => pages.value.map((page) => page.blocks.map((block) => block.id).join('\n')).join('\n'),
    (ids) => {
      const live = new Set(ids.split('\n'))
      const kept = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => live.has(id)))

      // Replaced rather than deleted from, and only when something is dead: a
      // new object is heard by everything that reads a size, which is right for
      // a chapter that has changed underneath it and wrong for one that has not.
      if (Object.keys(fits.value).some((id) => !live.has(id))) fits.value = kept(fits.value)
      if (Object.keys(keys.value).some((id) => !live.has(id))) keys.value = kept(keys.value)
    },
  )
}

/** What a block is fitted from — one place, so a fit and a capacity (`capacityOf`) measure the same thing. */
function inputOf (
  block: Block,
  box: LetterBox,
  style: Lettering,
  size: { w: number, h: number },
  vertical: boolean,
  family: string,
  shape: ReturnType<typeof shapeFor>,
  lang: string,
) {
  return {
    text: block.translation || block.source,
    box: { w: (box.w / 100) * size.w, h: (box.h / 100) * size.h },
    line: style.line ?? AUTO_LINE,
    spacing: style.spacing,
    bold: style.bold,
    italic: style.italic,
    vertical,
    family,
    shape: shapeOutline(shape, style.points),
    anchor: style.anchor,
    lang,
  }
}

export function useLetteringFit () {
  /**
   * Block id to the size it fits at, in the scan's own pixels — every page's,
   * not only the one on screen. It held only the page on screen and was rebuilt
   * on every turn, so each page was measured again, and first drawn at a guess,
   * every time it was turned to.
   */
  const fits = useState<Record<string, LetterFit>>('lettering-fits', () => ({}))

  /** The input each entry was measured from, so unchanged blocks are not redone. */
  const keys = useState<Record<string, string>>('lettering-fit-keys', () => ({}))

  // Kept to the blocks that exist — see `pruneFits`. Once for the tab, not once
  // per caller: the board, the Lettering panel and the export all call this.
  if (import.meta.client && !upkeep) {
    upkeep = effectScope(true)
    upkeep.run(() => pruneFits(fits, keys))
  }

  /**
   * How many faces have landed since the app started — watched by the board so
   * a block waiting on its face is fitted the moment it arrives. No longer part
   * of any key: nothing is measured until its face is here.
   */
  const faces = useState('lettering-faces', () => 0)

  /** Whether the sizes kept from earlier visits have been read back yet. */
  const ready = useState('lettering-fits-ready', () => false)

  /** The chapter's standard size — see `useLetteringStandard` — and the language being lettered. */
  const { standard } = useLetteringStandard()
  const target = useState('workspace-target', () => 'en')

  if (import.meta.client && !reading) {
    reading = idb.get<{ v: number, sizes: [string, LetterFit][] }>(STORE)
      .then((held) => {
        if (held?.v !== FITS_VERSION) return

        // Kept ones first, so anything measured while this was reading wins.
        for (const [key, size] of held.sizes) if (!remembered.has(key)) remembered.set(key, size)
      })
      .catch(() => {})
      .finally(() => { ready.value = true })
  }

  /**
   * Fit whatever needs it on this page.
   *
   * Only the blocks with no size of their own — a block whose size was written
   * down is not being fitted — and only the ones whose input has changed, so
   * typing into one balloon does not re-lay-out the other eight on every
   * keystroke. A block whose face has not arrived is left unfitted, which the
   * board draws as nothing rather than as a guess — see `fitOf`.
   */
  function refit (
    page: ComicPage | undefined,
    styleOf: (block: Block) => Lettering,
    setDown: (block: Block) => boolean,
  ) {
    const scan = page?.scan

    if (!import.meta.client || !ready.value || !page || !scan?.width || !scan.height) return

    const size = { w: scan.width, h: scan.height }
    const fitted = fits.value
    const measured = keys.value
    const held = standard.value
    const lang = target.value

    for (const block of page.blocks) {
      const style = styleOf(block)
      const shape = shapeFor(style, block)

      // A size written down is not being fitted — unless the lines wrap into a
      // shape, which needs its words walked into place at whatever size, and
      // says whether that size overflows. A plain box at a chosen size needs
      // neither, and is left alone as it always was.
      if (style.size !== null && shape === 'box') continue

      const box = letterBoxOf(block)

      // Which way it is set changes what fits: a column of ten characters wants
      // the balloon's height where a line of them wants its width.
      const vertical = setDown(block)
      const family = fontStack(faceOf(style.font, block.type))

      // Not measured in a face that is still on its way — see `loadFace`.
      if (!loadFace(family, style.bold, style.italic, () => { faces.value += 1 })) continue

      // Only a translation is held to the standard: a line still showing what
      // was read is a placeholder, set to fill its box as it always was.
      const aim = style.size ?? (block.translation.trim() && standardApplies(block.type) ? held : null)
      // Asking starts the patterns loading; their arrival brings this back, as a face's does.
      const breaks = hyphenationReady(lang, () => { faces.value += 1 })
      const plan = { shape: shape === 'custom' ? `custom:${style.points?.join(',')}` : shape, standard: aim, lang, breaks }
      const key = keyOf(block, box, style, family, vertical, size, plan)

      if (measured[block.id] === key && fitted[block.id] !== undefined) continue

      let fit = remembered.get(key)

      if (fit === undefined) {
        const input = inputOf(block, box, style, size, vertical, family, shape, lang)
        const range = letteringRange(size.w).size

        fit = style.size !== null
          ? fitAt(input, style.size)
          : aim !== null ? fitStandard(input, aim, range) : fitSize(input, range)

        remember(key, fit)
      }

      /*
       * Written in place, a block at a time, and only where the size moved.
       *
       * Both maps used to be copied whole at the top of every pass and handed
       * back as new objects whenever anything had changed. They hold every
       * page's blocks, not the one being fitted, and this runs on every
       * keystroke into a balloon, every frame of a frame being resized, every
       * tick of a lettering slider and once per page of an export — so each of
       * those copied the whole chapter's fits twice, and each change replaced
       * the object every `fitOf` reads through: everything that had read any
       * block's size, the board and the Lettering panel among them, ran again
       * for whichever block had moved. An export did that once per page it
       * fitted, to a board showing a page it was not fitting.
       *
       * A key written in place is heard only by what read that key.
       */
      measured[block.id] = key

      if (fitted[block.id] !== fit) fitted[block.id] = fit
    }
  }

  /**
   * Whether the face a block is set in has arrived — asked by the board of every
   * block, fitted or sized by hand.
   *
   * A block with a size of its own needs no fit, and so used to be drawn at once
   * — in the fallback, for the frames until its face arrived, then in the face.
   * On opening a chapter that was the three hand-sized balloons on a page showing
   * a frame or two before the rest, in the wrong letters. So they wait for the
   * face too, and appear with everything else.
   *
   * Asking starts the load if nobody has, and `faces` moving is what brings the
   * board back here when it lands — the same bargain `refit` makes.
   */
  function faceReady (block: Block, style: Lettering): boolean {
    // Read, so whatever asks during a render is drawn again when a face lands.
    const _landed = faces.value

    return loadFace(fontStack(faceOf(style.font, block.type)), style.bold, style.italic, () => { faces.value += 1 })
  }

  /**
   * The size a block has been fitted at, or nothing yet — what the board draws
   * with, and hides the block without. Never a guess: a guess is what used to be
   * drawn for a frame and then visibly corrected.
   */
  function fitOf (block: Block): LetterFit | undefined {
    return fits.value[block.id]
  }

  /**
   * The size a block is set at when it has none of its own: what was measured,
   * or the guess until that has happened. For the Lettering panel, which shows a
   * number either way; the board uses `fitOf`.
   */
  function autoSize (block: Block, style: Lettering, scan: { width: number, height: number }): number {
    const found = fits.value[block.id]

    if (found !== undefined) return found.size

    const box = letterBoxOf(block)

    return estimateSize(
      block.translation || block.source,
      { w: (box.w / 100) * scan.width, h: (box.h / 100) * scan.height },
      style.line ?? AUTO_LINE,
      letteringRange(scan.width).size,
    )
  }

  /**
   * Desktop: the size a line would take filling its frame with nothing holding
   * it — no standard, no size chosen. What a review measures a line's actual
   * size against (`review_lettering`): a line set well under its capacity is
   * small in a balloon that has room for more. Null where its face has not
   * arrived, or there is no scan to size by.
   */
  function capacityOf (page: ComicPage, block: Block, style: Lettering, vertical: boolean): number | null {
    const scan = page.scan

    if (!scan?.width || !scan.height) return null

    const family = fontStack(faceOf(style.font, block.type))

    if (!loadFace(family, style.bold, style.italic, () => { faces.value += 1 })) return null

    const size = { w: scan.width, h: scan.height }
    const input = inputOf(block, letterBoxOf(block), style, size, vertical, family, shapeFor(style, block), target.value)

    return fitSize(input, letteringRange(size.w).size).size
  }

  return { fits, faces, ready, refit, fitOf, faceReady, autoSize, capacityOf }
}
