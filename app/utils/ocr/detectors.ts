/**
 * The detectors, as one list — what they are called, what they are for, and
 * the one call that runs whichever was picked.
 *
 * The same shape as `readers.ts`, for the same reason: choosing between them
 * should be a value in a dropdown rather than a branch in every caller. The
 * bench and the workspace panel both draw this list, so a detector added here
 * appears in both without either being touched.
 *
 * What this list exists to keep straight is that there are two axes here and
 * they are not the same axis. A *family* is a model — an architecture, a
 * preprocessing, an idea of what a box is. A *build* is one export of that
 * model, heavier or lighter, differing in nothing but weight count. Three
 * builds of the comic detector and three of PP-OCRv6 are six entries and two
 * families, and flattening them into six siblings loses the only distinction
 * that actually changes what comes back.
 *
 * Neutral shapes live here rather than in either implementation, so neither
 * family is the one the other has to import from.
 */

/** What a detector can call a region it found. */
export type DetectedLabel = 'bubble' | 'text_bubble' | 'text_free' | 'text_line'

/** One piece of lettering a detector found, in page pixels. */
export interface DetectedText extends Region {
  label: DetectedLabel
  /** Nought to one. */
  score: number
  /**
   * The region's own four corners, where the detector drew a rotated one.
   *
   * The box above is this quad's axis-aligned extent, because that is what
   * every consumer downstream is built on — the overlay, the block, the mask.
   * The quad is kept alongside rather than instead, for the one consumer that
   * can use it: a recogniser cropping a tilted sound effect wants the tilted
   * rectangle, not a loose upright box two-thirds full of artwork.
   */
  quad?: Vertex[]
  /**
   * The balloon this lettering sits in, where the detector drew one.
   *
   * The comic detector has a `bubble` class — the balloon itself, not the text
   * in it — and it was thrown away at the point of detection for a good local
   * reason: every consumer of this list wants somewhere to *read*, and a
   * balloon shape offered as a text region is a duplicate reading of the words
   * already inside it. Discarding it also threw away the only thing on the page
   * that says where a balloon ends, which is exactly what a flood fill needs
   * and cannot work out for itself. Paired here instead, once, where both lists
   * exist — so it travels with the text region and a caller that does not care
   * never sees it.
   *
   * Untrimmed, unlike the box above: `TRIM` shaves the detector's balloon air
   * off a *text* box because the air is padding there. Here the air is the
   * balloon, and shaving it would clip the room off the ends of every rounded
   * one.
   */
  bubble?: Region
}

export type FamilyId = 'comic' | 'ppocr'

export interface Family {
  label: string
  /** What this family answers in — the thing that actually differs. */
  note: string
}

/**
 * The two models, and the sentence that decides between them.
 *
 * Not a preference: they fail in different places, which is why both are here.
 * The comic detector knows what a balloon is and will miss text it has no
 * category for; PP-OCRv6 knows only that writing has a texture and will find
 * lettering the other walks past, then hand it back cut into lines.
 */
export const FAMILIES: Record<FamilyId, Family> = {
  comic: { label: 'Comic detector', note: 'Balloons and free text, comic-trained' },
  ppocr: { label: 'PP-OCRv6', note: 'Text lines, any script, no idea what a balloon is' },
}

export type DetectorId = ComicBuild | PaddleBuild

export interface Detector {
  id: DetectorId
  /** Which model this is a build of. */
  family: FamilyId
  label: string
  /** What this build is worth against its siblings, in a few words. */
  note: string
  /**
   * What it costs to fetch the first time, in bytes — one file, the same on
   * either backend, since where a build runs follows from its precision rather
   * than the other way round (`detectorBackend`). Shown through `formatBytes`.
   */
  bytes: number
  /**
   * What it fetches instead where the GPU can run half precision, for the one
   * build that has an fp16 file — see `fullPrecision`.
   */
  halfBytes?: number
}

export const DETECTORS: Detector[] = [
  { id: 'fast', family: 'comic', label: 'Fast', note: 'The smallest download; misses more', bytes: 11_120_765 },
  { id: 'accurate', family: 'comic', label: 'Accurate', note: 'Heavier, catches more', bytes: 43_838_857 },
  {
    id: 'full',
    family: 'comic',
    label: 'Full',
    note: 'Unquantised — the most thorough, and on WebGPU the quickest',
    bytes: 168_481_531,
    halfBytes: 84_724_335,
  },
  { id: 'paddle-tiny', family: 'ppocr', label: 'Tiny', note: 'Only for seeing whether it is worth it', bytes: 1_780_590 },
  { id: 'paddle-small', family: 'ppocr', label: 'Small', note: 'The one to reach for', bytes: 9_880_512 },
  { id: 'paddle-medium', family: 'ppocr', label: 'Medium', note: 'Best recall, six times the download', bytes: 62_032_837 },
]

export const DETECTORS_BY_ID = new Map(DETECTORS.map((detector) => [detector.id, detector]))

/** What a build fetches the first time on this machine, in bytes — see `readerBytes`. */
export function detectorBytes (detector: Pick<Detector, 'bytes' | 'halfBytes'>, machine: { gpu: boolean, half: boolean }): number {
  return machine.gpu && machine.half && detector.halfBytes !== undefined ? detector.halfBytes : detector.bytes
}

/**
 * Where to land when a family is chosen and nothing else is known — and, for the
 * comic family, the detector a first run is given (`useOcr`'s settings).
 *
 * Not the smallest build in either case. `paddle-tiny` exists to answer whether
 * the family is worth trying at all, and landing somebody there by default
 * would answer it wrongly. And the comic default is `full` since 2026-09-30,
 * where it had been `fast` for its eleven megabytes: on WebGPU the unquantised
 * build is the quickest of the three as well as the most thorough (162 ms a
 * page — see `detectorBackend`), and the download is paid once per install.
 */
export const DEFAULT_BUILD: Record<FamilyId, DetectorId> = {
  comic: 'full',
  ppocr: 'paddle-small',
}

/** Which family a build belongs to, for a control that picks the two in turn. */
export function familyOf (id: DetectorId): FamilyId {
  return DETECTORS_BY_ID.get(id)?.family ?? 'comic'
}

/** The builds of one family, in the order they are listed — for grouped menus. */
export function buildsOf (family: FamilyId): Detector[] {
  return DETECTORS.filter((detector) => detector.family === family)
}

/**
 * "PP-OCRv6 small", for a place with no room to group.
 *
 * The label on its own says "Small", which only means anything next to its
 * siblings. Where a dropdown can nest them it should; where it cannot, this.
 */
export function fullLabel (id: DetectorId): string {
  const detector = DETECTORS_BY_ID.get(id)

  if (!detector) return id

  return `${FAMILIES[detector.family].label} ${detector.label.toLowerCase()}`
}

/**
 * The detector to find *balloons* with, given the one chosen for reading: the
 * chosen build where it is one that draws balloons, the comic family's default
 * (`DEFAULT_BUILD.comic`) where it is not — PP-OCR finds lines, and a run of it
 * would find no balloon to measure. It said `fast` until `full` became the
 * default, and would have measured a PP-OCR reader's balloons with the one
 * build nobody chose. The one answer, for Measure balloons and View › Balloon
 * debug both, so the two can never measure the same page with different
 * detectors and disagree about what they found.
 */
export function balloonDetector (chosen: DetectorId): DetectorId {
  return DETECTORS_BY_ID.get(chosen)?.family === 'comic' ? chosen : DEFAULT_BUILD.comic
}

/**
 * Find the lettering on a page with the chosen detector.
 *
 * Every entry gives back the same boxes, in page pixels, surest first — the
 * neutral shape above — so a caller picks a value and is done. What a family
 * wants beyond that is its own business and is not in this signature: the
 * PP-OCRv6 thresholds are arguments to `detectWithPaddle`, which the bench
 * calls directly when it is sweeping them. See `paddle.ts`.
 */
export function detectWith (
  id: DetectorId,
  page: Readable,
  onProgress?: MangaProgress,
  /** `full`'s precision, where the bench wants one — see `detectWithComic`. */
  precision?: FullPrecision,
): Promise<DetectedText[]> {
  if (id in PADDLE_DET_MODELS) return detectWithPaddle(page, onProgress, id as PaddleBuild)

  return detectWithComic(page, onProgress, id as ComicBuild, precision)
}
