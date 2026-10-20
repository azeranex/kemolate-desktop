/**
 * The readers, as one list — what they are called, what they are for, and
 * the one call that runs whichever was picked.
 *
 * Every reader here gives back the same blocks, which is the whole point of
 * the neutral shapes in `shared/utils/ocr.ts`: choosing between them is a
 * value in a dropdown rather than a branch in every caller. The bench and
 * the workspace panel both draw this list, so a reader added here appears in
 * both without either being touched.
 *
 * They are not all the same shape underneath, and the list says so rather
 * than hiding it. Most of them only *recognise* — they read a crop somebody
 * else found, which is what `detector.ts` is for. Vision does both halves
 * itself, so it takes the whole page and ignores the detector entirely; it
 * also spends the reader's own key and is the one entry here that sends a
 * page off this machine. Both facts are flags on the entry, so the panel can
 * say them out loud instead of the caller having to know.
 */
import type { Provider } from '#shared/utils/providers'

export type ReaderId = 'manga' | 'manga-2025' | 'kemolate-beta' | PaddleEngine | 'vision' | 'lab'

export interface Reader {
  id: ReaderId
  label: string
  /** Which lettering it is the right answer for, in a few words. */
  note: string
  /**
   * What it fetches the first time, in bytes — the files as the Hub and this
   * install's cache hold them. On WebAssembly, or everywhere where the build
   * does not depend on the backend. Shown through `formatBytes`, which is the
   * app's one decision about units: these were hand-written megabytes once, in
   * two different sizes of megabyte, and one of them was not true at all.
   */
  bytes?: number
  /**
   * What it fetches instead where WebGPU is on offer, when that is a different
   * build — manga-ocr's fp32 encoder, the beta's fp32 pair. The label used to
   * give the WebAssembly figure to a browser about to fetch more than twice
   * that: "200 MB" over a 460 MB download. See `readerBytes`.
   */
  gpuBytes?: number
  /**
   * What it fetches where that GPU can run half precision (`shader-f16`), when
   * there is an fp16 build — which is then what is read with. See
   * `mangaPrecision` and `betaPrecision`.
   */
  halfBytes?: number
  /** Finds its own lettering: no detector, and the page goes over whole. */
  detects?: boolean
  /** Whose key it spends — set only for the ones that are not run here. */
  provider?: Provider
  /**
   * Runs against a development server rather than in the browser — the crops
   * leave this machine for another one on the same desk. Flagged so the panel
   * can say so, and so a build that ships can drop it.
   */
  lab?: boolean
}

/**
 * Tesseract was here and is not any more: as a detector it merged balloons and
 * missed vertical runs, and as a reader it was behind everything here on the
 * pages this app is for. Not a bad engine; an engine for documents.
 *
 * PaddleOCR went with it and has come back. The old objection — that its
 * recogniser is horizontal by construction and a vertical balloon would have to
 * be cut into characters and laid back out flat — turned out to be wrong: it
 * turns tall crops on their side and reads the glyphs sideways, which is how it
 * was trained. It reads vertical Japanese at better than 0.98 a line.
 *
 * It is still not a straight swap for manga-ocr, for a different reason. It
 * returns *lines*, so a balloon of three columns arrives as three readings that
 * something has to put back in order, where manga-ocr reads the balloon whole.
 * What it adds that nothing local had is Korean and Chinese. See
 * `paddle-rec.ts`.
 */
/*
 * Desktop: no Manga OCR. The web build lists Manga OCR and Manga OCR 2025 first,
 * and Manga OCR is its default; here both are off the list and Kemolate OCR — this
 * project's own retrain, which reads Japanese better than either and Korean and
 * Chinese besides — is the default (`useOcr`). Their code is untouched
 * (`readWithMangaOcr` still takes `base` and `2025`, and `ReaderId` still names
 * them), so either can come back by putting its entry back here. A reader
 * remembered as one of them is not a reader this list has, so `heldOcrSettings`
 * drops it and the default stands.
 */
export const READERS: Reader[] = [
  // This project's own retrain, out26 — see `KEMOLATE_OCR_BETA_MODEL`. The q8
  // pair on WebAssembly, the fp32 pair on WebGPU, the fp16 pair where it can run
  // it (`betaPrecision`). The encoder is the same size every run; the decoder and
  // the tokenizer grow with the vocabulary (11,331 tokens from out21), so these
  // are out26's own files.
  {
    id: 'kemolate-beta',
    label: 'Kemolate OCR (beta)',
    note: 'Japanese, Korean and Chinese',
    bytes: 87_069_314 + 37_644_136 + 148_655,
    gpuBytes: 343_445_471 + 149_355_275 + 148_655,
    halfBytes: 171_988_882 + 74_802_377 + 148_655,
  },
  // A line each, like the rest. These four carried a paragraph apiece, which
  // in a panel dropdown wrapped to four lines and pushed the readers below
  // them off the bottom of the list — a sentence nobody scrolls to explains
  // nothing. What the tiers cost is in `bytes` and drawn beside the name; what
  // is left here is what a reader cannot work out from either.
  { id: 'ppocr-tiny', label: 'PP-OCRv6 Tiny', note: 'Japanese and Chinese — misses small lettering', detects: true, bytes: engineBytes('ppocr-tiny') },
  { id: 'ppocr-small', label: 'PP-OCRv6 Small', note: 'Japanese and Chinese, the one to reach for', detects: true, bytes: engineBytes('ppocr-small') },
  { id: 'ppocr-medium', label: 'PP-OCRv6 Medium', note: 'Japanese and Chinese, best on hard lettering', detects: true, bytes: engineBytes('ppocr-medium') },
  { id: 'ppocr-korean', label: 'PP-OCRv5 (Korean)', note: 'Korean only', detects: true, bytes: engineBytes('ppocr-korean') },
  {
    id: 'vision',
    label: 'Google Vision',
    note: 'Any script, and finds its own lettering',
    detects: true,
    provider: 'vision',
  },
  {
    id: 'lab',
    label: 'Lab (multilingual)',
    note: 'Japanese, Korean, Chinese — needs the lab server running',
    lab: true,
  },
]

export const READERS_BY_ID = new Map(READERS.map((reader) => [reader.id, reader]))

/**
 * What the machine a label is drawn for will run models on: WebGPU at all, and
 * a GPU that can run half precision (`shader-f16`).
 */
export interface ModelMachine {
  gpu: boolean
  half: boolean
}

/**
 * What a reader fetches the first time on this machine, in bytes — the build
 * it will actually read with there, and nothing for a reader that fetches
 * nothing (Vision, the lab).
 *
 * The machine is the caller's to say rather than read here, because a label
 * drawn on the server has no GPU to ask about: a component says no GPU until
 * it has mounted (`useModelMachine`), so the server and the first render
 * agree, and the figure corrects itself a moment later.
 */
export function readerBytes (reader: Pick<Reader, 'bytes' | 'gpuBytes' | 'halfBytes'>, machine: ModelMachine): number | undefined {
  if (!machine.gpu) return reader.bytes
  if (machine.half && reader.halfBytes !== undefined) return reader.halfBytes

  return reader.gpuBytes ?? reader.bytes
}

/**
 * What a reader may want beyond the page, where only some of them want it.
 *
 * An object rather than a tail of positional arguments because the wants are
 * unrelated to each other: a caller supplying a script should not have to know
 * what a key is, and adding the third of these should not renumber the first
 * two at every call site.
 */
export interface ReadOptions {
  /** Only wanted by readers with a `provider`, and the caller's to fetch. */
  key?: string
}

/**
 * Run a page through the chosen reader.
 *
 * `regions` is what a detector found, and is ignored by the readers that find
 * their own — Vision, which finds them remotely, and PP-OCR, which runs its
 * own detector locally so that its line recogniser is handed lines.
 */
export function readWithReader (
  id: ReaderId,
  page: Readable,
  regions?: Region[],
  onProgress?: MangaProgress,
  options: ReadOptions = {},
): Promise<ReadBlock[]> {
  if (id === 'vision') {
    if (!options.key) throw new Error('No Google Vision key yet — add one in settings.')

    onProgress?.('Sending the page to Google…')

    return readWithVision(options.key, page)
  }

  if (id.startsWith('ppocr-')) return readWithPaddleOcr(page, id as PaddleEngine, onProgress)

  if (id === 'lab') return readWithLab(page, regions, onProgress)

  return readWithMangaOcr(page, regions, onProgress, id === 'manga-2025' ? '2025' : id === 'kemolate-beta' ? 'beta' : 'base')
}
