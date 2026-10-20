import type { ComicPage } from '~/composables/useComic'
import type { DetectedText, DetectorId } from '~/utils/ocr/detectors'
import type { RoomReason } from '~/utils/ocr/rooms'

// Imported rather than auto-imported: new exports are unknown to a running dev
// server until it restarts, and this file is where several of them meet.
import { sized } from '~/composables/useComic'
import { toPatch } from '~/utils/ocr/blocks'
import { balloonDetector, DEFAULT_BUILD, detectWith } from '~/utils/ocr/detectors'
import { fencesOf, roomVerdicts } from '~/utils/ocr/rooms'
import { paintFill, VERDICT_COLOUR } from '~/utils/ocr/trace'
import { readScanSheet } from '~/utils/paper'

/**
 * Whether the canvas draws each block's balloon frames — View › Balloon debug —
 * and the measurement it draws them from.
 *
 * A translation can be lettered into three different boxes, and which one it
 * got is decided by a rule rather than shown: a frame somebody placed by hand,
 * else the room measured inside its balloon (`Block.room`), else the block's
 * own Reading box — see `letterBoxOf`. When a line sits somewhere surprising
 * the first question is which of the three it is in, so the canvas draws all
 * three for every block, in the OCR lab's colours, with a word on which wins.
 *
 * ## The fill, measured again
 *
 * The frames are what the workspace stores. The coloured fill the lab shows —
 * the balloon's interior as the flood found it, and the detector's balloon it
 * was held to — is not stored anywhere, so for the page on screen it is
 * measured again: the detector for the balloons, then `roomVerdicts` over this
 * chapter's own blocks, exactly as "Measure balloons" runs it. Drawn onto one
 * transparent picture the size of the page and laid over it.
 *
 * Which also makes it a check: the verdict is what the rules say *now*, so a
 * room stored under older rules, or a block moved since it was measured, shows
 * as a disagreement on its label. Nothing is written — the stored room is only
 * ever changed by measuring on purpose.
 *
 * One page at a time and only while the view is on: the detector is a second
 * or so a page. Kept per page for as long as the tab is, so turning back is
 * free; a block moved or re-read changes the key and measures again.
 *
 * Per tab and not remembered, deliberately — a debugging view left on is a
 * page covered in rectangles the next morning with nothing saying why.
 */

/** One page's measurement, drawn. */
export interface BalloonFills {
  /** Which page, and which state of its blocks — see `keyOf`. */
  key: string
  /** The traced fills and the detector's balloons, as an image the size of the page. */
  url: string
  /** Each block's verdict now, by block id. */
  verdicts: Record<string, { reason: RoomReason, gain?: number }>
}

/** A page and the blocks on it, as a key: moving or re-reading one measures again. */
function keyOf (page: ComicPage) {
  return `${page.id}|${page.scan?.url ?? ''}|${page.blocks.map((block) => [block.id, block.x, block.y, block.w, block.h, block.type, block.angle ?? 0].join(',')).join(';')}`
}

/**
 * How long the reader must stay on a page before it is measured. Turning pages
 * quickly with the view on used to start a measurement per page, all running at
 * once — several detector runs and their flood fills on the tab being turned —
 * and froze it. A page passed through in less than this is never measured.
 */
const SETTLE = 400

const kept = new Map<string, BalloonFills>()

/**
 * The detector's findings per scan. The one slow step — most of a second on a
 * page, and on the main thread where WebGPU is not open — and the only one that
 * depends on nothing but the picture, so a block moved or re-read measures
 * again without detecting again.
 */
const detected = new Map<string, Promise<DetectedText[]>>()

/**
 * How many measurements and detections are kept. A measurement holds a
 * page-sized picture behind an object URL, and every block moved makes a new
 * one, so neither map may simply grow for as long as the tab lives: one entry
 * per page, the oldest pages let go, and every picture let go revoked.
 */
const KEEP = 12
const DETECTIONS = 24

/** Keep a page's measurement, and let go of its older ones and of the oldest pages. */
function keep (page: ComicPage, key: string, measured: BalloonFills) {
  const prefix = `${page.id}|`

  for (const [other, old] of kept) {
    if (other !== key && other.startsWith(prefix)) {
      URL.revokeObjectURL(old.url)
      kept.delete(other)
    }
  }

  kept.set(key, measured)

  for (const [other, old] of kept) {
    if (kept.size <= KEEP) break

    URL.revokeObjectURL(old.url)
    kept.delete(other)
  }
}

/** The detector's findings for a scan, with the detector Measure balloons would use. */
function detection (scan: { file: Blob, url: string }, width: number, detector: DetectorId) {
  const key = `${detector}|${scan.url}`
  let found = detected.get(key)

  if (!found) {
    found = detectWith(detector, { file: scan.file, width })
    detected.set(key, found)
    // A failed detection is not kept, or the page could never be measured again.
    found.catch(() => detected.delete(key))

    for (const other of detected.keys()) {
      if (detected.size <= DETECTIONS) break

      detected.delete(other)
    }
  }

  return found
}

/** The page most recently asked for, and whether a measurement is running. */
let wanted: ComicPage | null = null
let running = false

/** A tick for the browser to paint and take input between heavy steps. */
const breathe = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export function useBalloonDebug () {
  const on = useState('balloon-debug', () => false)

  /** The page on screen's measurement, once there is one. */
  const fills = useState<BalloonFills | null>('balloon-debug-fills', () => null)

  /** Why there is no measurement for the page on screen, when there is not. */
  const note = useState<string | null>('balloon-debug-note', () => null)

  const busy = useState('balloon-debug-busy', () => false)

  /**
   * Ask for a page to be measured.
   *
   * Latest wins, one at a time: a measurement already running is left to reach
   * its next step, where it notices it has been overtaken and gives up; pages
   * turned past in the meantime are dropped rather than queued. See `SETTLE`.
   */
  function measure (page: ComicPage) {
    const already = kept.get(keyOf(page))

    if (already) {
      wanted = null
      fills.value = already
      note.value = null

      return
    }

    fills.value = null
    note.value = null
    wanted = page

    if (!running) drain()
  }

  async function drain () {
    running = true
    busy.value = true

    try {
      while (wanted) {
        const page = wanted

        await new Promise((resolve) => setTimeout(resolve, SETTLE))

        // Turned on again while settling: start over with the newer page.
        if (wanted !== page) continue

        wanted = null
        await measureOne(page, () => wanted !== null)
      }
    } finally {
      running = false
      busy.value = false
    }
  }

  /** One page, abandoned at any step where `stale` says a newer page was asked for. */
  async function measureOne (page: ComicPage, stale: () => boolean) {
    const key = keyOf(page)

    if (!page.scan) {
      note.value = 'The picture is not on this machine, so the fill cannot be measured here.'

      return
    }

    try {
      const size = await sized(page)
      const scan = page.scan

      if (!scan || !size.width || stale()) return

      // The detector Measure balloons would use — see `balloonDetector` — or the
      // debug view would measure with one build and the stored rooms have come
      // from another, and disagree about what they found.
      const chosen = useState<{ detector?: DetectorId } | undefined>('ocr-settings').value?.detector ?? DEFAULT_BUILD.comic
      const regions = await detection(scan, size.width, balloonDetector(chosen))

      if (stale()) return

      const sheet = await readScanSheet(scan)

      if (!sheet) {
        note.value = 'That page could not be decoded.'

        return
      }

      await breathe()

      if (stale()) return

      const fences = fencesOf(regions)
      const verdicts = roomVerdicts(sheet, page.blocks.map((block) => toPatch(block, size)), fences, size.width)

      await breathe()

      if (stale()) return

      // Every fill written into one buffer at the sheet's own size — see
      // `paintFill` — and the detector's balloons dashed over it.
      const canvas = new OffscreenCanvas(sheet.w, sheet.h)
      const context = canvas.getContext('2d')!
      const image = context.createImageData(sheet.w, sheet.h)

      for (const verdict of verdicts) {
        if (verdict.balloon) paintFill(image, verdict.balloon, VERDICT_COLOUR[verdict.reason])
      }

      context.putImageData(image, 0, 0)

      // A room in clear paper has no fill to trace — it was grown as a
      // rectangle — so the rectangle is what is drawn, hatched like a fill.
      context.save()
      context.strokeStyle = VERDICT_COLOUR.clear!
      context.fillStyle = VERDICT_COLOUR.clear!
      context.lineWidth = 1.5

      for (const verdict of verdicts) {
        if (verdict.reason !== 'clear' || !verdict.room) continue

        const x = (verdict.room.cx - verdict.room.w / 2) * sheet.w
        const y = (verdict.room.cy - verdict.room.h / 2) * sheet.w
        const w = verdict.room.w * sheet.w
        const h = verdict.room.h * sheet.w

        context.globalAlpha = 1
        context.strokeRect(x, y, w, h)
        context.globalAlpha = 0.25
        context.fillRect(x, y, w, h)
      }

      context.restore()

      const toSheet = sheet.w / size.width

      context.setLineDash([4, 3])
      context.lineWidth = 1
      context.strokeStyle = 'rgba(234, 179, 8, 0.95)'

      for (const fence of fences) {
        context.strokeRect(fence.x * toSheet, fence.y * toSheet, fence.w * toSheet, fence.h * toSheet)
      }

      const measured: BalloonFills = {
        key,
        url: URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })),
        verdicts: Object.fromEntries(page.blocks.map((block, at) => [block.id, {
          reason: verdicts[at]!.reason,
          ...(verdicts[at]!.gain === undefined ? {} : { gain: verdicts[at]!.gain }),
        }])),
      }

      keep(page, key, measured)

      // Shown only if nothing newer was asked for meanwhile; kept either way,
      // so turning back to this page is free.
      if (!stale()) fills.value = measured
    } catch (thrown) {
      if (!stale()) note.value = thrown instanceof Error ? thrown.message : String(thrown)
    }
  }

  return { on, fills, note, busy, measure, keyOf }
}
