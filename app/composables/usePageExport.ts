/**
 * The chapter as finished pages — a PDF, or a zip of PNGs or JPEGs — made in
 * this browser from everything the workspace holds.
 *
 * The project file (`useProjectFile`) is the chapter's *work*: scans, readings,
 * strokes, layers, to be opened again. This is its *result*: each page as the
 * board shows it, flattened at the scan's own resolution, lettering and all,
 * for reading somewhere that is not this app. Nothing leaves the browser on the
 * way; the file is handed to the reader as a download.
 *
 * Every page is drawn here, not only the ones visited, so each is gathered the
 * way the rest of the app gathers a page it is not showing:
 *
 * - its **stack** as the server keeps it for a cloud workspace (`serverStacks`),
 *   since a page not turned to this session still holds the default it opened
 *   with; a local workspace's is already on the page;
 * - its **strokes** from both logs, merged (`paint/gather`);
 * - its **repairs** and **placed pictures** as the chapter's own records of them;
 * - its **lettering** fitted by the same `refit` the board uses — so a page
 *   fitted on screen is exported at exactly those sizes — and inked by the same
 *   paper reading (`paperAt`), set with the board's own CSS (`letterCss`).
 *
 * A line with no translation is left off rather than lettered in the original:
 * the board shows it in orange italics as a reminder, which is not something to
 * print. The dialog says how many there are before anything is made.
 *
 * ## Drawing here, encoding elsewhere, keeping on disk
 *
 * A page is drawn on this thread, because its lettering is laid out by the
 * browser as HTML, and nowhere else can. Everything after that is not: the
 * drawn page is copied into a bitmap (a few milliseconds) and handed to an
 * encoder thread (`export/encoder.ts`), and the next page is drawn while it is
 * encoded. It used to be `toBlob` on this thread, a page at a time — 1.1 s a
 * page of which the page stalled for 100–230 ms, and in a tab in the background
 * much longer, since Chrome encodes a canvas in idle time the background gets
 * little of. `export/pipeline.ts` keeps the pages in order and holds the export
 * to as many pages in flight as there are encoders (`exportEncoders`), since
 * each is a whole bitmap; `export/spill.ts` puts each finished page on disk, so
 * the export is never all in memory; and each encoder sums what it made, so
 * packing a zip reads nothing back (`ZipEntry.crc`).
 *
 * Measured on the eight 3732 × 5197 pages of the test chapter, in a tab in the
 * background: an export took 2.9–4.2 s — 56 s when idle time was scarce — and
 * now takes 1.5–2.1 s whatever the format; the page's long tasks went from 2–15
 * an export, up to 240 ms, to 0–3, none over 170 ms. Those left are the drawing.
 *
 * The files are the ones `toBlob` made, byte for byte: the bitmap is the drawn
 * canvas copied whole, laid on a canvas of its own size and put through the
 * same encoder — see `encode.ts`.
 *
 * "Export" repeats the last export of this workspace in this browser; the
 * settings are kept under `workspace:<id>:export`, which goes with the
 * workspace when it is deleted.
 */
import type { Drawn, StackLayer } from '#shared/utils/layers'
import type { Block, ComicPage } from './useComic'
import type { EncodeJob } from '~/utils/export/encode'
import type { LetterItem } from '~/utils/export/letters'
import type { Placed } from '~/utils/export/render'
import type { PagePaint } from '~/utils/paint/gather'

import { DEFAULT_STACK, paintOrder, plateAdjusts } from '#shared/utils/layers'
import { inking, shapeFor, shapeOutline, verticalOf } from '#shared/utils/lettering'
import { download } from '~/utils/download'
import { encoderPool } from '~/utils/export/encoder'
import { drawLettering } from '~/utils/export/letters'
import { pipeline } from '~/utils/export/pipeline'
import { renderPage } from '~/utils/export/render'
import { openSpill, sweepExports } from '~/utils/export/spill'
import { hashFile } from '~/utils/hash'
import { idb } from '~/utils/idb'
import { letterPlaced, letterSet, LINE_BOX, shapeParts, superIn } from '~/utils/letterCss'
import { localPaint, mergePaint, remotePaint } from '~/utils/paint/gather'
import { paperAt, readScanSheet } from '~/utils/paper'
import { writePdf } from '~/utils/pdf/write'
import { placedOver, repairOvers } from '~/utils/raster/engine/overs'
import { exportEncoders } from '~/utils/resources'
import { zip } from '~/utils/zip'

export type ExportFormat = 'pdf' | 'png' | 'jpeg'

export interface ExportSettings {
  format: ExportFormat
  /** JPEG quality, 0.5–1 — for JPEG pages and the pages inside a PDF. */
  quality: number
  /** One-based and inclusive, as the page counter numbers them — or null for every page. */
  range: { from: number, to: number } | null
}

export const EXPORT_DEFAULTS: ExportSettings = { format: 'pdf', quality: 0.92, range: null }

export interface ExportProgress {
  page: number
  pages: number
  message: string
}

/**
 * Asked to stop: the page being drawn is finished, the pages already with an
 * encoder are let finish — a few hundred milliseconds — and nothing is made.
 * Module state, because the dialog that shows the stop and the menu that
 * started the export are two callers of this composable, and a flag each would
 * never meet.
 */
let stopping = false

/**
 * Whether this tab has cleared away the pages earlier exports left on disk —
 * see `sweepExports`. Once a session, and a while after opening, since nothing
 * about opening a chapter should wait on it.
 */
let swept = false

const SWEEP_AFTER = 15_000

/** What is kept of an export, per workspace, for "Export" to repeat. */
const keyOf = (workspace: string) => `workspace:${workspace}:export`

/** A page's file name inside a zip: its number, then its own name, stripped to what every system accepts. */
function entryName (index: number, page: ComicPage, ext: string): string {
  const stem = page.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.\- ]+/g, '_').trim() || 'page'

  return `${String(index + 1).padStart(3, '0')}-${stem}.${ext}`
}

/** A download's name from the chapter's title. */
const fileStem = (title: string) => title.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'chapter'

/**
 * A drawn page as a bitmap to hand to an encoder, and the canvas given back —
 * 78 MB at 3732 × 5197, and the next page is about to want its own.
 */
async function handOff (canvas: HTMLCanvasElement): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(canvas)
  } finally {
    canvas.width = 0
  }
}

/** One finished page of an export, as it is kept until the file is put together. */
interface Finished {
  name: string
  /** On disk where the spill took it, in memory where it did not — see `export/spill.ts`. */
  data: Blob
  crc: number | null
  width: number
  height: number
}

/** A picture's bytes, decoded — or null where they will not come. */
const decode = (url: string) => fetch(url).then((response) => response.blob()).then((blob) => createImageBitmap(blob)).catch(() => null)

export function usePageExport () {
  const route = useRoute()
  const { pages, title, styleOf } = useComic()
  const { shared, pageRowOf } = useShared()
  const patchMap = usePatchMap()
  const { urlFor } = usePlacedImages()
  const { refit, fitOf, ready: fitsReady } = useLetteringFit()
  const target = useState('workspace-target', () => 'en')

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const progress = useState<ExportProgress | null>('export-progress', () => null)
  const last = useState<ExportSettings | null>('export-last', () => null)

  const running = computed(() => progress.value !== null)

  if (import.meta.client && !swept) {
    swept = true
    setTimeout(sweepExports, SWEEP_AFTER)
  }

  /** This workspace's last export, read back — for "Export" and for the dialog to start from. */
  async function recall (): Promise<ExportSettings | null> {
    if (!workspace.value) return null

    const held = await idb.get<ExportSettings>(keyOf(workspace.value)).catch(() => undefined)

    last.value = held ?? null

    return last.value
  }

  /** The pages a range means, as they stand. */
  function chosen (range: ExportSettings['range']): { page: ComicPage, index: number }[] {
    const all = pages.value.map((page, index) => ({ page, index }))

    if (!range) return all

    const from = Math.max(1, Math.min(range.from, range.to))
    const to = Math.min(pages.value.length, Math.max(range.from, range.to))

    return all.slice(from - 1, to)
  }

  /** What an export of these pages would leave out, for the dialog to say before it starts. */
  function shortfall (range: ExportSettings['range']) {
    const picked = chosen(range)

    return {
      pages: picked.length,
      noScan: picked.filter(({ page }) => !page.scan).length,
      untranslated: picked.reduce((n, { page }) => n + page.blocks.filter((block) => !block.hidden && !block.translation.trim()).length, 0),
    }
  }

  /** Which way a block is set on *this* page — `useComic.setDown` asks the page on screen. */
  function setDownIn (block: Block, size: { width: number, height: number }): boolean {
    const style = styleOf(block)

    if (style.vertical !== null) return style.vertical

    const box = letterBoxOf(block)

    return verticalOf(style, block, { w: (box.w / 100) * size.width, h: (box.h / 100) * size.height })
  }

  /** Every face a page's lettering is set in, loaded — so `refit` measures in it rather than skipping. */
  async function loadFaces (blocks: Block[]) {
    if (!document.fonts) return

    await Promise.all(blocks.map((block) => {
      const style = styleOf(block)
      const family = fontStack(faceOf(style.font, block.type))

      return document.fonts.load(`${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} 16px ${family}`, block.translation).catch(() => [])
    }))
  }

  /** A page's lettering plates, as the board would set them at one pixel to the scan pixel. */
  async function letteringOf (page: ComicPage, size: { width: number, height: number }) {
    const shown = page.blocks.filter((block) => !block.hidden && block.translation.trim())

    if (!shown.length) return { dialogue: [], sfx: [] }

    // The fit waits for the faces and the saved fits, as it does on screen.
    await loadFaces(shown)

    for (let tries = 0; !fitsReady.value && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100))

    refit(page, styleOf, (block) => setDownIn(block, size))

    // The paper under each block, for the ink — only where the reader has not
    // chosen both colours, which is most blocks and costs one small read.
    const needsPaper = shown.some((block) => {
      const style = styleOf(block)

      return !style.color || !style.outline
    })

    const sheet = needsPaper && page.scan ? await readScanSheet(page.scan).catch(() => null) : null
    const space = { page: size, unit: 1 }

    const items = (plate: 'dialogue' | 'sfx'): LetterItem[] => shown
      .filter((block) => (plate === 'sfx') === (block.type === 'sfx'))
      .flatMap((block) => {
        const style = styleOf(block)
        const fit = fitOf(block)
        const fitted = style.size ?? fit?.size

        if (fitted === undefined) return []

        const frame = letterBoxOf(block)
        const paper = sheet ? paperAt(sheet, blockBoxOf(block), page.scan) : null
        const down = setDownIn(block, size)
        // A line that does not fit is set in its box, as on the board — see `partsOf` there.
        const outline = fit?.over ? null : shapeOutline(shapeFor(style, block), style.points)

        return [{
          place: letterPlaced(frame, space),
          set: letterSet({ style, type: block.type, size: fitted, down, ink: inking(style, paper), fit }, superIn(frame, space)),
          line: LINE_BOX,
          parts: outline ? shapeParts(outline, down, fit?.pad ?? 0) : null,
          lang: target.value,
          text: block.translation,
        }]
      })

    return { dialogue: items('dialogue'), sfx: items('sfx') }
  }

  /** One page, drawn. */
  async function drawPage (page: ComicPage, stack: StackLayer[], paint: PagePaint): Promise<HTMLCanvasElement | null> {
    const scan = page.scan

    if (!scan) return null

    await sized(page)

    const bitmap = await createImageBitmap(scan.file).catch(() => null)

    if (!bitmap) return null

    // The decoded picture is the last word on the page's size — see `measure`.
    const size = { width: bitmap.width, height: bitmap.height }
    const held: ImageBitmap[] = [bitmap]

    try {
      const repairs = await Promise.all(repairOvers(page, patchMap.value[page.id], patchStands).map(async (over): Promise<Placed | null> => {
        const picture = await decode(over.url)

        if (picture) held.push(picture)

        return picture ? { bitmap: picture, sx: over.sx, sy: over.sy, sw: over.sw, sh: over.sh } : null
      }))

      const pile = paintOrder(stack)

      // Placed pictures decoded ahead, since `renderPage` asks for them as it goes.
      const pictures = new Map<string, Placed>()

      for (const row of pile) {
        if (row.kind !== 'image' || !row.image || !row.visible) continue

        const url = urlFor(row.image)
        const over = url ? placedOver(size, row.image, url) : null
        const picture = over ? await decode(over.url) : null

        if (picture && over) {
          held.push(picture)
          pictures.set(row.key, { bitmap: picture, sx: over.sx, sy: over.sy, sw: over.sw, sh: over.sh })
        }
      }

      const letters = await letteringOf(page, size)

      return await renderPage({
        size,
        scan: bitmap,
        pile,
        adjusts: plateAdjusts(stack),
        repairs: repairs.filter((one): one is Placed => one !== null),
        placed: (row: Drawn) => pictures.get(row.key) ?? null,
        paint,
        lettering: (plate) => drawLettering(size, letters[plate]),
      })
    } finally {
      for (const one of held) one.close()
    }
  }

  /**
   * Make and download the export. True when a file was handed over; false
   * when there was nothing to make, it was stopped, or it failed (said).
   */
  async function run (settings: ExportSettings): Promise<boolean> {
    if (running.value) return false

    const picked = chosen(settings.range).filter(({ page }) => page.scan)

    if (!picked.length) {
      toast.warning('Nothing to export', { description: 'None of these pages has its picture on this computer.' })

      return false
    }

    stopping = false
    progress.value = { page: 0, pages: picked.length, message: 'Gathering…' }

    const png = settings.format === 'png'
    const ext = png ? 'png' : 'jpg'

    // A zip wants each entry's checksum and a PDF does not, so only a zip's
    // encoders are asked to sum what they make.
    const job: EncodeJob = png
      ? { type: 'image/png', crc: true }
      : { type: 'image/jpeg', quality: settings.quality, crc: settings.format === 'jpeg' }

    const encoders = exportEncoders()
    const pool = encoderPool(encoders)
    const spill = await openSpill()

    // Whether the file was handed over, which decides how soon the pages kept
    // on disk may go: not before the browser has read them into the download.
    let delivered = false

    try {
      const stacks = shared.value ? await serverStacks(workspace.value, pages.value, pageRowOf).catch(() => null) : null
      const painted = await remotePaint(shared.value ? workspace.value : null)

      const finished = await pipeline<ImageBitmap, Finished>(picked.length, {
        inFlight: encoders,
        stopped: () => stopping,

        make: async (n) => {
          const { page, index } = picked[n]!

          progress.value = { page: n + 1, pages: picked.length, message: `Drawing page ${index + 1}…` }

          const hash = page.scan!.hash ?? await hashFile(page.scan!.file).catch(() => null)
          const paint = hash ? mergePaint(await localPaint(hash), page.uid ? painted.get(page.uid) : undefined) : {}
          const stack = stacks?.get(page.id) ?? page.stack ?? DEFAULT_STACK
          const canvas = await drawPage(page, stack, paint)

          return canvas ? handOff(canvas) : null
        },

        finish: async (bitmap, n) => {
          const { page, index } = picked[n]!
          const name = entryName(index, page, ext)

          // Read before the bitmap is handed over: a transferred bitmap is
          // nought by nought on this side.
          const { width, height } = bitmap
          const { blob, crc } = await pool.encode(bitmap, job)

          return { name, data: await spill.keep(name, blob), crc, width, height }
        },

        drop: (bitmap) => bitmap.close(),

        settling: () => {
          progress.value = { page: picked.length, pages: picked.length, message: 'Finishing the last pages…' }
        },
      })

      const made = finished?.filter((one): one is Finished => one !== null) ?? []

      if (stopping || !made.length) return false

      progress.value = { page: picked.length, pages: picked.length, message: 'Packing…' }

      const stem = fileStem(title.value)

      if (settings.format === 'pdf') {
        download(writePdf(made.map((one) => ({ jpeg: one.data, width: one.width, height: one.height })), { title: title.value }), `${stem}.pdf`)
      } else {
        download(await zip(made.map((one) => ({ name: one.name, data: one.data, ...(one.crc === null ? {} : { crc: one.crc }) }))), `${stem}.zip`)
      }

      delivered = true
      last.value = settings
      await idb.set(keyOf(workspace.value), JSON.parse(JSON.stringify(settings)) as ExportSettings).catch(() => {})

      toast.success(`Exported ${made.length} ${made.length === 1 ? 'page' : 'pages'}`)

      return true
    } catch (error) {
      toast.error('The export could not be made', { description: error instanceof Error ? error.message : String(error) })

      return false
    } finally {
      pool.close()

      if (delivered) spill.settle()
      else await spill.discard()

      progress.value = null
    }
  }

  /**
   * One page as it would be exported, as a PNG — for the dialog to show before
   * anything is made, and nothing downloaded. `index` is the page's place in
   * the chapter.
   */
  async function preview (index: number): Promise<Blob | null> {
    const page = pages.value[index]

    if (!page?.scan) return null

    const stacks = shared.value ? await serverStacks(workspace.value, [page], pageRowOf).catch(() => null) : null
    const painted = await remotePaint(shared.value ? workspace.value : null)
    const hash = page.scan.hash ?? await hashFile(page.scan.file).catch(() => null)
    const paint = hash ? mergePaint(await localPaint(hash), page.uid ? painted.get(page.uid) : undefined) : {}
    const canvas = await drawPage(page, stacks?.get(page.id) ?? page.stack ?? DEFAULT_STACK, paint)

    if (!canvas) return null

    // On an encoder thread like the export's own pages, so a look at a page
    // does not stall the one on screen for the 230 ms a PNG read back here did.
    const pool = encoderPool(1)

    try {
      return (await pool.encode(await handOff(canvas), { type: 'image/png', crc: false })).blob
    } finally {
      pool.close()
    }
  }

  /** Stop at the end of the page being drawn. */
  function stop () {
    stopping = true
  }

  return { progress, running, last, recall, shortfall, preview, run, stop }
}
