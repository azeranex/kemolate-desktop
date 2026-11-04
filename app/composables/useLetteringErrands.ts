/**
 * Answering an agent's questions about the lettering — the window half of
 * `review_lettering`. Desktop.
 *
 * Two questions, both of which only this window can answer, because the
 * lettering is set here and nowhere else:
 *
 * - **How is each line fitted?** A line's automatic size is measured in the
 *   window, in its face, in its frame (`useLetteringFit`), and kept in the
 *   window's own storage — never in the database. So the page is fitted here,
 *   as an export fits it, and each line's size, what decided it, and the size
 *   it would take with nothing holding it (`capacityOf`) go back to the server
 *   (`/fits/:request`, see `server/utils/fits.ts`).
 * - **What does it look like?** The page as lettered is the export's picture of
 *   it (`usePageExport.preview` — cleaning, layers, lettering, all of it), made
 *   small or cropped the way a scan is shown to an agent (`renditionOf`), and
 *   posted through the same relay (`/relay/:request`). A review asks for several
 *   balloons of one page in a row, so the drawn page is kept for a few seconds
 *   rather than drawn again for each.
 *
 * Only for the chapter open here, as `useReadErrands` — a hash names a scan, and
 * two workspaces can be made from the same scans.
 *
 * Called once, from the workspace page, beside `useReadErrands`.
 */
import { caughtUp } from '~/composables/useLiveSync'
import { ordinaryPitch } from '~/utils/emphasis'
import { hyphenationReady } from '~/utils/hyphens'
import { rowOf } from '~/utils/ocr/blocks'

/** Where a line's ink lands on the page, in the scan's pixels. */
interface Ink { left: number, top: number, right: number, bottom: number }

/** How far two lines' ink must overlap, both ways, before they are said to run into each other — a rounding error is not. */
const TOUCH = 2

/**
 * Desktop: which lines' ink runs into which — several lines in one balloon,
 * each in a room cut round its own original, set wider than the original and
 * over its neighbour ("MOMENTARE PLOTTING", 2026-10-23). Upright boxes round
 * the ink, which is what a reader sees collide; a turned frame is measured as
 * if it were not.
 */
export function collisions (inks: ReadonlyMap<number, Ink>): Map<number, number[]> {
  const hits = new Map<number, number[]>()
  const all = [...inks]

  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const [one, first] = all[a]!
      const [other, second] = all[b]!
      const across = Math.min(first.right, second.right) - Math.max(first.left, second.left)
      const down = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)

      if (across > TOUCH && down > TOUCH) {
        hits.set(one, [...(hits.get(one) ?? []), other])
        hits.set(other, [...(hits.get(other) ?? []), one])
      }
    }
  }

  return hits
}

/** How long a drawn page is kept for the next crop of it, in milliseconds. */
const KEEP_DRAWN = 15_000

export function useLetteringErrands () {
  const { pages, styleOf } = useComic()
  const { refit, fitOf, ready, capacityOf, emphasisFor, linesOf } = useLetteringFit()
  const { standard } = useLetteringStandard()
  const { preview } = usePageExport()
  const target = useState('workspace-target', () => 'en')

  const open = String(useRoute().params.workspaceId ?? '')

  /** Which way a block is set on this page — `useComic.setDown` asks the page on screen. See `usePageExport`. */
  function setDownIn (block: Block, size: { width: number, height: number }): boolean {
    const style = styleOf(block)

    if (style.vertical !== null) return style.vertical

    const box = letterBoxOf(block)

    return verticalOf(style, block, { w: (box.w / 100) * size.width, h: (box.h / 100) * size.height })
  }

  /** Every face and the language's breaks in hand, so the fit is the one the page will draw. */
  async function settle (blocks: Block[]) {
    if (document.fonts) {
      await Promise.all(blocks.map((block) => {
        const style = styleOf(block)

        return document.fonts.load(`${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} 16px ${fontStack(faceOf(style.font, block.type))}`, block.translation).catch(() => [])
      }))
    }

    await new Promise<void>((resolve) => {
      if (hyphenationReady(target.value, resolve)) resolve()
    })

    for (let tries = 0; !ready.value && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100))
  }

  /** Each translated line on a page, as fitted — see `LineFit` in `server/utils/fits.ts`. */
  async function measure (page: ComicPage) {
    const scan = page.scan!
    const size = { width: scan.width, height: scan.height }
    const shown = page.blocks.filter((block) => !block.hidden && block.type !== 'garbage' && block.translation.trim())

    await settle(shown)

    refit(page, styleOf, (block) => setDownIn(block, size))

    const usual = ordinaryPitch(pages.value, pageSize)

    // Desktop: where each line's ink lands on the page, so lines that run into each other are said — see `collisions`.
    const inks = new Map<number, Ink>()

    const lines = shown.flatMap((block) => {
      const row = rowOf(block)
      const style = styleOf(block)
      const fit = fitOf(block)
      const fitted = style.size ?? fit?.size

      if (row === null || fitted === undefined) return []

      const set = style.size !== null ? 'chosen' as const : standard.value !== null && standardApplies(block.type) ? 'standard' as const : 'auto' as const
      const { emphasis, measured } = emphasisFor(page, block, style, usual)
      const drawn = linesOf(page, block, style, setDownIn(block, size))
      const frame = letterBoxOf(block)

      if (drawn?.ink) {
        const left = (frame.x / 100) * size.width
        const top = (frame.y / 100) * size.height

        inks.set(row, { left: left + drawn.ink.left, top: top + drawn.ink.top, right: left + drawn.ink.right, bottom: top + drawn.ink.bottom })
      }

      return [{
        blockId: row,
        size: Math.round(fitted * 10) / 10,
        set,
        capacity: capacityOf(page, block, style, setDownIn(block, size)),
        over: Boolean(fit?.over),
        tight: Boolean(fit?.tight),
        hyphens: Boolean(fit?.hyphens),
        // Only a line held to the standard is multiplied; the measure is reported either way.
        emphasis: set === 'standard' ? emphasis : 1,
        measuredEmphasis: measured,
        ...(style.emphasis !== null && style.emphasis !== undefined ? { emphasisChosen: true } : {}),
        // The lines as drawn, and how they broke — a balloon's breaks judged from its words.
        ...(drawn ? { drawn: drawn.lines, wrapped: drawn.wrapped, broken: drawn.broken, byHand: drawn.byHand } : {}),
        ...(fit?.rewrapped ? { rewrapped: true } : {}),
      }]
    })

    const hits = collisions(inks)

    return lines.map((line) => (hits.get(line.blockId)?.length ? { ...line, collides: hits.get(line.blockId) } : line))
  }

  /** The page as lettered, drawn once and kept briefly for the next crop. */
  let drawn: { id: string, at: number, blob: Promise<Blob | null> } | null = null

  // A change an agent made — a restyle, a new standard — is what the next look
  // is for; a page drawn before it would show the old lettering.
  onSwarmChange(() => { drawn = null })
  watch(standard, () => { drawn = null })

  function letteredOf (page: ComicPage): Promise<Blob | null> {
    if (drawn && drawn.id === page.id && Date.now() - drawn.at < KEEP_DRAWN) return drawn.blob

    const index = pages.value.indexOf(page)
    const blob = preview(index).catch(() => null)

    drawn = { id: page.id, at: Date.now(), blob }

    return blob
  }

  onLetterErrand(async (workspace, errand) => {
    const found = workspace === open ? pages.value.find((candidate) => candidate.scan?.hash === errand.hash) : undefined

    // An agent asks about what it has just written: the page is brought up to
    // date with the notice of that write first — see `caughtUp` — and looked up
    // again, because catching up puts new blocks on it.
    if (found) await caughtUp(found)

    const page = found ? pages.value.find((candidate) => candidate.id === found.id) : undefined

    if (errand.type === 'fits') {
      const report = (body: Record<string, unknown>) =>
        $fetch(`/api/workspaces/${workspace}/fits/${errand.request}`, { method: 'POST', body }).catch(() => {})

      if (!page?.scan) {
        await report({ ok: false, error: workspace === open ? 'Kemolate is not holding that page.' : 'Kemolate has another chapter open.' })

        return
      }

      try {
        await report({ ok: true, standard: standard.value, lines: await measure(page) })
      } catch (error) {
        await report({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }

      return
    }

    // A picture of the page as lettered. Silent where it cannot be made, as a
    // scan's is: the asker's timeout says so to the one who can act on it.
    if (!page?.scan) return

    const blob = await letteredOf(page)
    const made = blob ? await renditionOf(blob, errand.maxEdge, errand.quality, errand.region).catch(() => null) : null

    if (!made) return

    await $fetch(`/api/workspaces/${workspace}/relay/${errand.request}`, {
      method: 'POST',
      body: made.blob,
      query: { type: made.blob.type || 'image/jpeg' },
    }).catch(() => {})
  })
}
