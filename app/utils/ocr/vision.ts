/**
 * Reading a page with Google Cloud Vision, from the browser.
 *
 * From the browser on purpose. The earlier build did this server-side, which
 * meant every page was uploaded to it and forwarded on; here the scans never
 * leave the machine they were opened on, and that promise is worth more than
 * the convenience of one shared key. So the request goes straight to Google:
 * the page is read where it already is, and nothing passes through us.
 *
 * The cost of that is the key. It belongs to whoever is using it, is kept in
 * their browser, and is theirs to spend — see `useVisionKey`. There is no
 * shared credential to leak because there is no shared credential.
 *
 * A key in a browser can be read by whoever owns the browser, which is fine —
 * it is their key. It is *not* fine for it to be read by anyone else, so the
 * advice attached to the key field is to restrict it to the Vision API and to
 * this origin in the Google console. That is the same posture every mapping
 * and analytics key on the web has, and the same one the earlier build had by
 * keeping the key on a server only its own user could reach.
 *
 * Everything about what the reading *means* — how lines join, which way a
 * vertical balloon reads, how a slanted box keeps its angle — is in
 * `shared/utils/ocr.ts` and knows nothing about Google. This file is only the
 * errand.
 */

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate'

/** Vision's own response, to the depth this file actually reads. */
interface VisionVertex { x?: number, y?: number }

interface VisionSymbol {
  text?: string
  property?: { detectedBreak?: { type?: string } }
}

interface VisionParagraph {
  boundingBox?: { vertices?: VisionVertex[] }
  words?: { symbols?: VisionSymbol[] }[]
}

interface VisionBlock {
  boundingBox?: { vertices?: VisionVertex[] }
  confidence?: number
  paragraphs?: VisionParagraph[]
}

interface VisionPage {
  width?: number
  height?: number
  blocks?: VisionBlock[]
}

/** The bytes of one page, and how wide it is — the two things a reading needs. */
export interface Readable {
  file: Blob
  width: number
}

/**
 * The symbols of a paragraph, with the detector's own breaks left in.
 *
 * Left in deliberately: whether a break reads as a space or as nothing is a
 * question about the script, and `tidyText` is the one that answers it. Losing
 * them here would be deciding it by accident.
 */
function paragraphText (paragraph: VisionParagraph): string {
  const out: string[] = []

  for (const word of paragraph.words ?? []) {
    for (const symbol of word.symbols ?? []) {
      out.push(symbol.text ?? '')

      const kind = symbol.property?.detectedBreak?.type

      if (kind) out.push(BREAKS[kind] ?? '')
    }
  }

  return out.join('')
}

const corners = (box?: { vertices?: VisionVertex[] }): Vertex[] =>
  (box?.vertices ?? []).map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 }))

/** Vision's shape, in the neutral one `shared/utils/ocr.ts` works in. */
function toDetections (page: VisionPage): Detection[] {
  return (page.blocks ?? []).map((block) => ({
    quad: corners(block.boundingBox),
    text: (block.paragraphs ?? []).map(paragraphText).join(''),
    ...(typeof block.confidence === 'number' ? { confidence: block.confidence } : {}),
    paragraphs: (block.paragraphs ?? []).map((paragraph) => ({
      quad: corners(paragraph.boundingBox),
      text: paragraphText(paragraph),
    })),
  }))
}

/** Base64 without the `data:` preamble, which is what Vision wants. */
function encode (file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(reader.error ?? new Error('The page could not be read.'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

/**
 * Read one page, and hand back blocks the app can use.
 *
 * `DOCUMENT_TEXT_DETECTION` rather than `TEXT_DETECTION`: the earlier build
 * compared them side by side and found they segment comics identically, but
 * only the first reports a per-block confidence — which is what separates
 * lettering from artwork it has misread as lettering.
 */
export async function readWithVision (key: string, page: Readable): Promise<ReadBlock[]> {
  const body = {
    requests: [{
      image: { content: await encode(page.file) },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    }],
  }

  const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    // Google's own message is the useful part — a bad key, a disabled API and
    // an exhausted quota all arrive here and read very differently.
    const detail = await response.text().catch(() => '')

    throw new Error(`Vision refused the page (${response.status}). ${detail.slice(0, 300)}`)
  }

  const result = await response.json() as {
    responses?: { error?: { message?: string }, fullTextAnnotation?: { pages?: VisionPage[] } }[]
  }

  const first = result.responses?.[0]

  if (first?.error) throw new Error(`Vision: ${first.error.message ?? 'unknown error'}`)

  const blocks: ReadBlock[] = []

  for (const found of first?.fullTextAnnotation?.pages ?? []) {
    // Vision reports the page's own dimensions; the caller's width is the
    // fallback for the rare response that does not.
    blocks.push(...readPage(toDetections(found), found.width || page.width))
  }

  return blocks
}
