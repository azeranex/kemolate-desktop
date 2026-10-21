/**
 * What colour the page is under each block, and therefore what colour the words
 * on it should be.
 *
 * The same shape as `useLetteringFit` and for the same reason: the answer costs
 * a canvas read, a render that took one for every block on every frame would be
 * a render that fights itself, so it is worked out after a change into a map the
 * canvas and the panel both read. One derivation, so the swatch the panel shows
 * is the colour the page is actually set in — the disagreement this codebase
 * keeps having to fix.
 *
 * Async where the fit is not, which is the only real difference. Decoding a
 * scan takes a frame or two, and nothing waits for it: until it lands every
 * block answers with the dark ink, which is what the page did before any of this
 * existed. So the worst a slow decode can do is show you the old behaviour for a
 * moment.
 *
 * `usePaper` and not `useInk`, because what is stored here is the *paper* — the
 * measurement. Which ink goes on it is `inking` in `shared/utils/lettering`,
 * pure and testable, and the reader's own choice overrides it there.
 */
import type { Paper } from '#shared/utils/lettering'
import type { ComicPage, PageScan } from '~/composables/useComic'
import type { Sheet } from '~/utils/paper'

// By hand, so a dev server already running picks the new export up.
import { readScanSheet } from '~/utils/paper'

/**
 * The page currently read, and which page that was.
 *
 * Module-level rather than in state, for the reason the font cache in
 * `app/utils/lettering` is: a decoded page is one object and two callers asking
 * about the same scan are asking the same question. It is deliberately one
 * page — turning the page throws the last one away — because a chapter of
 * decoded sheets is real memory held for a question nobody is asking any more.
 */
let sheet: { key: string, sheet: Sheet } | null = null

/** The read in flight, so a second call on the same frame joins it rather than
 *  starting a second decode of the same file. */
let reading: { key: string, done: Promise<Sheet | null> } | null = null

/**
 * Which scan this is. The object URL rather than the hash: a hash is null until
 * the file has been identified, which happens well after the page is on screen,
 * and a key that is null for every page is one key for all of them.
 */
const scanKey = (scan: PageScan) => scan.url

async function sheetOf (scan: PageScan): Promise<Sheet | null> {
  const key = scanKey(scan)

  if (sheet?.key === key) return sheet.sheet
  if (reading?.key === key) return reading.done

  // From the scan decoder where the page's size is known — which it is for any
  // page on screen — and by a decode of its own only where it is not.
  const read = scan.width && scan.height ? readScanSheet(scan) : readSheet(scan.file)

  const done = read.then((read) => {
    if (read) sheet = { key, sheet: read }
    if (reading?.key === key) reading = null

    return read
  })

  reading = { key, done }

  return done
}

export function usePaper () {
  /** Block id to the colour found under it, as `#rrggbb`. */
  const papers = useState<Record<string, string>>('block-paper', () => ({}))

  /** What each entry was read from, so an unmoved block is not read again. */
  const keys = useState<Record<string, string>>('block-paper-keys', () => ({}))

  /**
   * Read whatever needs reading on this page.
   *
   * The *block's* box, not the lettering frame's, and that is a real choice.
   * The block's box is where the printed lettering was found, so it is inside
   * the balloon by construction — which is exactly what reading inside it
   * depends on. A lettering frame can be dragged anywhere, and is most often
   * dragged *wider*, out past the balloon's outline and onto the art; a reading
   * of that would answer with the artwork's colour and set white lettering into
   * a white balloon.
   *
   * So a frame moved right off its balloon keeps its balloon's colour. That is
   * the lesser wrong of the two, and the letterer who moved it has the swatch
   * in the panel to say otherwise with.
   */
  async function restock (page: ComicPage | undefined) {
    const scan = page?.scan

    if (!import.meta.client || !page || !scan) return

    const read = await sheetOf(scan)

    if (!read) return

    const key = scanKey(scan)
    const next: Record<string, string> = {}
    const nextKeys: Record<string, string> = {}
    let changed = false

    for (const block of page.blocks) {
      const box = blockBoxOf(block)
      // Rounded, because a box arrives as a float off a drag and the sheet is
      // 640 across: a tenth of a percent is well under a pixel of it, and
      // re-reading thirty blocks for a movement that cannot change one of them
      // is the whole cost this key exists to avoid. The turn, lean and corners
      // too, since what is read is the shape the block is drawn as.
      const at = [
        key, box.x.toFixed(1), box.y.toFixed(1), box.w.toFixed(1), box.h.toFixed(1),
        Math.round(box.angle ?? 0), Math.round(box.skewX ?? 0), Math.round(box.skewY ?? 0), box.quad?.map(Math.round).join(',') ?? '',
      ].join('|')

      if (keys.value[block.id] === at) {
        nextKeys[block.id] = at

        const found = papers.value[block.id]

        if (found) next[block.id] = found

        continue
      }

      const paper = paperAt(read, box, scan)

      if (paper) next[block.id] = hexOf([paper.r, paper.g, paper.b])

      nextKeys[block.id] = at
      changed = true
    }

    // Written back only when something actually moved, including a block having
    // left the list — otherwise every pass hands back a fresh object and sets
    // everything that reads this drawing again for nothing.
    if (!changed && Object.keys(next).length === Object.keys(papers.value).length) return

    papers.value = next
    keys.value = nextKeys
  }

  /** What was found under a block, or nothing if it has not been read yet. */
  function paperOf (block: Block): Paper | null {
    const found = papers.value[block.id]

    if (!found) return null

    const [r, g, b] = rgbOf(found)

    return { r, g, b }
  }

  /**
   * How a block's lettering is coloured — the reader's choice over the page's.
   *
   * The style is passed in rather than read off the block, because the panel
   * asks this about the selection's shared style while the canvas asks it about
   * one block's own, and they are not always the same object.
   */
  const inkOf = (block: Block, style: Lettering): Inking => inking(style, paperOf(block))

  return { papers, restock, paperOf, inkOf }
}
