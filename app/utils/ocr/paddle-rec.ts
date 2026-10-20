/**
 * Reading a line of lettering with PP-OCRv6, entirely in the browser.
 *
 * The other half of `paddle.ts`, and the half this app did without for a long
 * time. manga-ocr reads Japanese beautifully and nothing else at all, so a
 * Korean or Chinese chapter had to go to Google — the one path here that takes
 * a page off the machine. These recognisers close that, from four megabytes
 * upwards.
 *
 * ## Why Korean is a separate engine
 *
 * There is no multilingual recogniser here, whatever the card says. PP-OCRv6's
 * vocabulary is 18,710 characters of kana, CJK, Latin and punctuation and
 * contains **no hangul at all** — not one syllable, not one jamo. Korean is a
 * separate model, an older v5 mobile build, whose 11,947 characters are hangul
 * and Latin and contain no kana or CJK in return. Neither can stand in for the
 * other, and a page sent to the wrong one comes back as confident nonsense
 * rather than as an error, which is why it is a choice somebody makes rather
 * than something guessed here.
 *
 * Japanese and Chinese need no choice at all: one vocabulary holds both.
 *
 * ## What a recogniser is, and what it is not
 *
 * This reads *one line* at a time, in a strip 48 pixels tall. It is a CTC
 * model: the strip becomes a row of frames, each frame votes for a character,
 * and the votes are collapsed left to right.
 *
 * That sounds like it rules out vertical Japanese and does not, which is the
 * one thing to understand before touching this file. A column taller than 1.5×
 * its width is turned on its side before the model sees it — see
 * `ROTATE_ABOVE` — and the model reads the sideways glyphs, having been
 * trained on them. Vertical balloons come back at better than 0.98 a line.
 * It still returns *lines* rather than balloons, so a multi-column balloon
 * arrives as several readings that something upstream has to put back in
 * order; that, and not orientation, is the real difference from manga-ocr.
 *
 * The vocabulary is fetched from the safetensors repo rather than the ONNX
 * one, because only the former ships it as JSON — the ONNX repos carry it
 * inside a Paddle-specific YAML that would need a parser to read one array.
 */
import { imageDimensions } from '~/utils/dimensions'
import { asideSize, jobKey, releaseAside } from '~/utils/raster/decoder'

/**
 * A whole PaddleOCR engine: a detector build and the recogniser that belongs
 * with it.
 *
 * One choice rather than two, because the two were never independent. PP-OCRv6
 * ships as a family — the demo that says "PP-OCRv6_medium" means medium at both
 * halves — and pairing a medium detector with a small recogniser finds the
 * lettering accurately and then reads it at the lower tier, which looks like a
 * detection problem and is not. Korean is its own entry because it is genuinely
 * a different model rather than another size of the same one.
 */
export type PaddleEngine = 'ppocr-tiny' | 'ppocr-small' | 'ppocr-medium' | 'ppocr-korean'

interface Recogniser {
  /** Where the graph lives, and where the vocabulary lives — different repos. */
  graph: string
  vocab: string
  /** What the graph costs to fetch the first time, in bytes. */
  bytes: number
}

/**
 * The CJK recognisers, one per build.
 *
 * The tiers are not equally forgiving, and the gap shows exactly where you
 * would expect it: on a large tilted sound effect, handed byte-identical
 * input, small reads `ああー` and medium reads `ああーっ`. The trailing small
 * kana is what the extra weights buy.
 *
 * One set of weights covers Japanese *and* Chinese — the vocabulary holds kana
 * and CJK together, so there is nothing to choose between them.
 */
const CJK: Record<PaddleBuild, Recogniser> = {
  'paddle-tiny': {
    graph: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
    vocab: 'PaddlePaddle/PP-OCRv6_tiny_rec_safetensors',
    bytes: 4_462_639,
  },
  'paddle-small': {
    graph: 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
    vocab: 'PaddlePaddle/PP-OCRv6_small_rec_safetensors',
    bytes: 21_159_378,
  },
  'paddle-medium': {
    graph: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx',
    vocab: 'PaddlePaddle/PP-OCRv6_medium_rec_safetensors',
    bytes: 76_554_979,
  },
}

/**
 * Korean has one build and no family — an older v5 mobile model that happens to
 * be the only one with hangul in it. Paired with the small v6 detector, since
 * detection is script-agnostic and there is no v5 detector worth preferring.
 */
const KOREAN: Recogniser = {
  graph: 'PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx',
  vocab: 'PaddlePaddle/korean_PP-OCRv5_mobile_rec_safetensors',
  bytes: 13_418_787,
}

const ENGINES: Record<PaddleEngine, { det: PaddleBuild, rec: Recogniser }> = {
  'ppocr-tiny': { det: 'paddle-tiny', rec: CJK['paddle-tiny'] },
  'ppocr-small': { det: 'paddle-small', rec: CJK['paddle-small'] },
  'ppocr-medium': { det: 'paddle-medium', rec: CJK['paddle-medium'] },
  'ppocr-korean': { det: 'paddle-small', rec: KOREAN },
}

/** What the pair costs to fetch the first time, in bytes — both halves. */
export function engineBytes (engine: PaddleEngine): number {
  const { det, rec } = ENGINES[engine]

  return rec.bytes + (DETECTORS_BY_ID.get(det)?.bytes ?? 0)
}

/** The strip every crop becomes, and the width it is padded out to at least. */
const STRIP_HEIGHT = 48
const MIN_WIDTH = 320

/**
 * How wide a strip may get before it is cut off.
 *
 * A very long line scaled to 48 tall can run to thousands of pixels, and the
 * graph is linear in that width. Paddle's own ceiling; a line that reaches it
 * is a line that was mis-detected.
 */
const MAX_WIDTH = 3200

/**
 * How sure the frames must be, on average, before a reading is kept.
 *
 * Deliberately far below Paddle's own `drop_score` of 0.5, and well below what
 * this file started at. Small lettering on a comic page reads *correctly* at
 * confidences that would be alarming in a document: a `って` set at fourteen
 * points came back right, and at 0.30, from both this reader and the reference
 * — which keeps it only because the published demo runs with no threshold at
 * all. Filtering at 0.5 threw away text that was never wrong, and the boxes
 * that vanished were exactly the small ones a reader most wants found.
 *
 * What survives at this floor is caught by `HAS_WORD` below instead, which is
 * the better instrument for it: the failure this guards against is not an
 * unsure reading but a confident one in the wrong alphabet — the Korean model
 * handed Japanese returns `—?` at *high* confidence and is quite right about
 * the punctuation. Nought stays excluded, because nought means the strip held
 * nothing at all.
 */
const MIN_CONFIDENCE = 0.25

/**
 * A reading has to contain something that is not punctuation.
 *
 * The confidence floor above catches a recogniser that is unsure, and misses
 * the case where it is sure and wrong: handed a line of an alphabet it does not
 * know, it finds a stroke that looks like a dash and a stroke that looks like a
 * question mark and reports `—?` at high confidence, because as punctuation
 * those readings are correct. Every script this file reads has letters, so a
 * reading made entirely of marks is a reading of something that was not text.
 */
const HAS_WORD = /[\p{L}\p{N}]/u

/**
 * Whether a detector quad is level enough to store as an upright box — within
 * the four-degree band `inkRect` and `detBoxFor` both snap to level.
 *
 * Read off the top edge, as `boxOf` reads the angle it stores, and folded into
 * ±45 so a quad that happens to start at another corner — a quarter turn of
 * the same rectangle — is judged by its lean and not by where it begins.
 */
export function nearlyLevel (quad: Vertex[]): boolean {
  const [tl, tr] = quad as [Vertex, Vertex]
  const degrees = (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI
  const lean = ((degrees % 90) + 135) % 90 - 45

  return Math.abs(lean) <= 4
}

/**
 * How tall a region must be against its width before it is turned on its side.
 *
 * This is the whole reason PP-OCR can read a vertical Japanese balloon, and it
 * is a single line of PaddleOCR's `get_rotate_crop_image` that is easy to miss:
 * a crop taller than 1.5× its width is rotated a quarter turn anticlockwise
 * before the recogniser ever sees it. The column then arrives as a horizontal
 * strip of glyphs lying on their sides, read left to right, which is precisely
 * what the model was trained on — vertical CJK appears in its training data
 * having been through the same rotation.
 *
 * Without it a column is scaled to 48 pixels tall keeping its aspect, so 60 by
 * 220 arrives thirteen pixels wide and reads as `13`, `元`, `至高`, `2`. With
 * it, the same page reads out at better than 0.98 a line. The direction matters
 * as much as the angle, since turning it the other way would read the column
 * bottom to top.
 *
 * Paddle's own value is 1.5, and 1.5 is wrong for short columns. A two-character
 * balloon is barely taller than it is wide once the detector's box has added its
 * margin: a real `って` came back 47 by 70 — a ratio of 1.489 — missed the cut by
 * a hundredth, arrived 32 pixels wide, and read as the single character `こ`.
 * That is the failure the paragraph above describes, at a box that happens to
 * fall just under the line.
 *
 * 1.2 catches those without disturbing lone glyphs, which sit near 1.0: measured
 * on a page of stacked kana, boxes at 1.02 stay upright and read correctly as
 * single characters while everything from 1.2 up is turned. Anything genuinely
 * horizontal is below 1.0 and nowhere near this.
 */
const ROTATE_ABOVE = 1.2

interface Loaded {
  session: InferenceSession
  /** Index to character, straight — entry nought is the CTC blank. */
  vocab: string[]
}

const loading = new Map<PaddleEngine, Promise<Loaded>>()

function loadOnce (engine: PaddleEngine, onProgress?: MangaProgress): Promise<Loaded> {
  const held = loading.get(engine)

  if (held) return held

  const { graph, vocab } = ENGINES[engine].rec

  const made = (async () => {
    const session = await sessionFor(`https://huggingface.co/${graph}/resolve/main/inference.onnx`, onProgress)

    onProgress?.('Fetching the character list…')

    const url = `https://huggingface.co/${vocab}/resolve/main/preprocessor_config.json`
    const response = await fetch(localModel(url))

    if (!response.ok) throw new Error(`The character list could not be fetched (${response.status}).`)

    const config = await response.json() as { character_list?: string[] }

    if (!config.character_list?.length) throw new Error('That recogniser shipped no character list.')

    return { session, vocab: config.character_list } satisfies Loaded
  })().catch((error) => {
    loading.delete(engine)
    throw error
  })

  loading.set(engine, made)

  return made
}

/**
 * One line crop as the strip this graph eats.
 *
 * Scaled to 48 tall keeping its aspect, laid against the left edge of a strip
 * padded with black to the right, and normalised to ±1. RGB here, where the
 * detector wanted BGR — the two halves of PaddleOCR disagree about channel
 * order and the configs are the only place that says so.
 *
 * A tall region is turned a quarter turn anticlockwise first — see
 * `ROTATE_ABOVE` — which is what lets a vertical column be read at all. The
 * rotation is done as a transform on the way in rather than through an
 * intermediate canvas, so the page's own pixels are resampled exactly once.
 */
function stripTensor (
  ort: Awaited<ReturnType<typeof ortOnce>>,
  bitmap: ImageBitmap,
  region: Region,
  quad?: Vertex[],
): OrtTensor {
  // The quad's own dimensions where there is one — the length of its top edge
  // and of its left — so a tilted sound effect is measured along itself rather
  // than across the upright box it happens to sit in.
  const span = (a: Vertex, b: Vertex) => Math.hypot(b.x - a.x, b.y - a.y)

  const cropW = quad ? Math.max(span(quad[0]!, quad[1]!), span(quad[3]!, quad[2]!)) : region.w
  const cropH = quad ? Math.max(span(quad[0]!, quad[3]!), span(quad[1]!, quad[2]!)) : region.h

  const sideways = cropH >= cropW * ROTATE_ABOVE

  // What the crop measures once it is the right way up: a rotated column is as
  // long as it was tall, and as tall as it was wide.
  const along = sideways ? cropH : cropW
  const across = sideways ? cropW : cropH

  const scale = STRIP_HEIGHT / Math.max(1, across)
  const drawn = Math.max(1, Math.min(MAX_WIDTH, Math.round(along * scale)))
  const width = Math.max(MIN_WIDTH, drawn)

  const canvas = new OffscreenCanvas(width, STRIP_HEIGHT)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) throw new Error('The line could not be cropped — no 2d context.')

  context.imageSmoothingQuality = 'high'

  // Straighten first, turn second. Both are transforms on the way in, so the
  // page's own pixels are resampled once however many stages this is.
  if (sideways) {
    // Read last call first, as the canvas walks it: the crop is drawn into a
    // box the size of the strip stood on its end, turned anticlockwise, and
    // dropped back down the strip's height. The lettering's top edge lands on
    // the left, which is the order the characters have to arrive in — turning
    // it the other way would read the balloon bottom to top.
    context.translate(0, STRIP_HEIGHT)
    context.rotate(-Math.PI / 2)
  }

  const boxW = sideways ? STRIP_HEIGHT : drawn
  const boxH = sideways ? drawn : STRIP_HEIGHT

  if (quad) {
    // PaddleOCR warps the quad flat with a perspective transform. These quads
    // come from `minAreaRect`, so they are always rectangles and the warp is
    // only ever a rotation and a scale — which the canvas does natively and
    // exactly, with no interpolation of its own on top.
    //
    // Read last call first, as the canvas applies them: a page pixel is moved
    // so the quad's top-left corner is the origin, turned until the quad's top
    // edge lies along the x axis, and scaled onto the box.
    const [tl, tr] = quad as [Vertex, Vertex]
    const lean = Math.atan2(tr.y - tl.y, tr.x - tl.x)

    context.scale(boxW / cropW, boxH / cropH)
    context.rotate(-lean)
    context.translate(-tl.x, -tl.y)

    // Only the quad's own corner of the page is handed over, drawn where it
    // belongs so the transform still lands it correctly. Passing the whole
    // bitmap would give the same picture — the transform crops either way —
    // and cost a full-page resample per line: measured, nine lines of a
    // thousand-pixel page took thirteen seconds that way and under one this.
    context.drawImage(
      bitmap,
      region.x, region.y, region.w, region.h,
      region.x, region.y, region.w, region.h,
    )
  } else {
    context.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, boxW, boxH)
  }

  context.setTransform(1, 0, 0, 1, 0, 0)

  const { data } = context.getImageData(0, 0, width, STRIP_HEIGHT)
  const plane = width * STRIP_HEIGHT
  const pixels = new Float32Array(3 * plane)

  for (let i = 0; i < plane; i++) {
    // Everything past the lettering stays at nought, which is where the
    // Float32Array already is. This is not a detail: PaddleOCR builds its
    // padding with `np.zeros` *after* normalising, so the pad is nought in
    // normalised space — mid-grey — while a canvas pads with transparent,
    // which normalises to minus one, a solid black slab. A short line is
    // mostly pad (`隣に` is 109 pixels of a strip 320 wide), so getting this
    // wrong does not blur the reading, it buries it: measured, `隣に` came
    // back as `に` at 0.35 against the reference's 0.98.
    if (i % width >= drawn) continue

    pixels[i] = (data[i * 4]! / 255 - 0.5) / 0.5
    pixels[plane + i] = (data[i * 4 + 1]! / 255 - 0.5) / 0.5
    pixels[2 * plane + i] = (data[i * 4 + 2]! / 255 - 0.5) / 0.5
  }

  return new ort.Tensor('float32', pixels, [1, 3, STRIP_HEIGHT, width])
}

/**
 * The frames' votes, collapsed into a reading.
 *
 * Plain CTC: take each frame's likeliest character, drop the runs where the
 * same one wins twice in a row, then drop the blank. The repeat rule is what
 * lets a wide glyph occupy several frames without being read several times,
 * and the blank between two genuine repeats — the second `ㄴ` of `안녕` — is
 * what stops that rule from eating them.
 */
function ctc (
  probabilities: Float32Array,
  frames: number,
  classes: number,
  vocab: string[],
): { text: string, confidence: number } {
  let text = ''
  let previous = -1
  let total = 0
  let counted = 0

  for (let frame = 0; frame < frames; frame++) {
    const from = frame * classes

    let best = 0
    let bestScore = -Infinity

    for (let id = 0; id < classes; id++) {
      const score = probabilities[from + id]!

      if (score > bestScore) {
        bestScore = score
        best = id
      }
    }

    // Nought is the blank, and it is also the thing that separates a genuine
    // double letter from one glyph spread over two frames — so it resets the
    // run rather than merely being skipped.
    if (best !== previous && best !== 0) {
      text += vocab[best] ?? ''
      total += bestScore
      counted++
    }

    previous = best
  }

  return { text, confidence: counted ? total / counted : 0 }
}

/**
 * Read the given line regions of a page.
 *
 * Regions are read one after another rather than raced: the graph holds the
 * machine either way, and a page is a few dozen lines rather than a few
 * thousand. Every reading is the region's own — nothing here joins lines into
 * paragraphs, because which lines belong together is a question about the
 * page's layout and is answered upstream.
 */
export async function readLines (
  page: Readable,
  regions: (Region & { quad?: Vertex[] })[],
  engine: PaddleEngine = 'ppocr-small',
  onProgress?: MangaProgress,
): Promise<Detection[]> {
  const loaded = await loadOnce(engine, onProgress)
  const ort = await ortOnce()
  const bitmap = await createImageBitmap(page.file)

  try {
    const detections: Detection[] = []

    for (const [index, region] of regions.entries()) {
      onProgress?.(`Reading ${index + 1} of ${regions.length}…`, { done: index, total: regions.length })

      const out = await loaded.session.run({
        [loaded.session.inputNames[0]!]: stripTensor(ort, bitmap, region, region.quad),
      })

      const probabilities = out[loaded.session.outputNames[0]!]!
      const [, frames, classes] = probabilities.dims as number[] as [number, number, number]

      const read = ctc(probabilities.data as Float32Array, frames, classes, loaded.vocab)
      const text = read.text.trim()

      if (!text || read.confidence < MIN_CONFIDENCE || !HAS_WORD.test(text)) continue

      // The detector's own quad where there is one, so a tilted sound effect
      // arrives downstream tilted — `boxOf` and the overlay both read the angle
      // straight off these four points, and squaring them here would throw away
      // the one thing this detector knew that the upright box does not.
      //
      // Except inside the same four-degree band every other source of a lean
      // honours (`inkRect`'s snap, `detBoxFor`). `minAreaRect` fits the
      // smallest rectangle to the network's blob, and a blob of upright
      // lettering is ragged enough that the smallest one is almost never
      // exactly level: a chapter read this way stored 31 lines at ±0.2–1.8°,
      // every one of them upright on the page. Those quads were the only thing
      // in the pipeline allowed to carry a lean that small.
      detections.push({
        quad: region.quad && !nearlyLevel(region.quad)
          ? region.quad
          : [
              { x: region.x, y: region.y },
              { x: region.x + region.w, y: region.y },
              { x: region.x + region.w, y: region.y + region.h },
              { x: region.x, y: region.y + region.h },
            ],
        text,
      })
    }

    return detections
  } finally {
    bitmap.close()
  }
}

/**
 * A page, found and read by PaddleOCR alone.
 *
 * Both halves are its own on purpose. A CTC recogniser wants one line in a
 * strip, and the boxes the comic detector draws are balloons holding several —
 * handing those over would feed it three lines stacked and get one line's worth
 * of nonsense back. `paddle.ts` cuts the page into lines, which is the input
 * this was trained on, so the two halves match by construction.
 *
 * That is why the reader is flagged as finding its own lettering: the detector
 * setting is not ignored out of carelessness but because a mismatched one here
 * is worse than no choice at all. The engine names both halves, so the two are
 * always the same tier.
 */
export async function readWithPaddleOcr (
  page: Readable,
  engine: PaddleEngine = 'ppocr-small',
  onProgress?: MangaProgress,
): Promise<ReadBlock[]> {
  const regions = await detectWithPaddle(page, onProgress, ENGINES[engine].det)

  if (!regions.length) return []

  // Lines come back as lines. Gathering them into balloons is a guess, and a
  // wrong one is silent — two balloons become one fluent sentence that reads
  // and translates perfectly and is not what the page says. An unmerged
  // balloon is three visible blocks somebody can join in a click. So the
  // grouping is offered rather than applied: see `suggestGroups` in
  // `balloons.ts`, which proposes and never decides.
  const detections = await readLines(page, regions, engine, onProgress)

  // Only the width, and the page usually says it. It used to be a full decode
  // either way — 78 MB and 200 ms on a large page, for one number the caller
  // had handed over. The header next, then a decode, off this thread.
  const width = page.width || (await imageDimensions(page.file))?.width || await (async () => {
    const key = jobKey('width')
    const size = await asideSize(key, page.file)

    releaseAside(key)

    return size.width
  })()

  return readPage(detections, width)
}
