/**
 * The scans inside a PDF, taken back out as the files they originally were.
 *
 * A PDF of a scanned chapter is not really a document — it is a stack of
 * images with a page of coordinates around each one, and the images are what
 * the person dropping the file means by it. So nothing here renders anything:
 * a JPEG is lifted out byte-for-byte identical to what the scanner produced,
 * and bare rasters (Flate over rows) are wrapped losslessly into PNG. Either
 * way the pixels that were in the file are the pixels in the pages, at full
 * resolution, at original size — not a screenshot of a page at some DPI.
 *
 * All of it on this machine, like every other way pages get in. See
 * `app/utils/images.ts`, which hands PDFs here and takes pages back.
 *
 * ## Two roads for a compressed raster, and which page takes which
 *
 * A raster stored as Flate over PNG-predicted rows is already a PNG's image
 * data, so it is put into a PNG as it is (`wrapped`) — no predictor loop and no
 * deflate, only an inflate to check it. Measured in Chrome on a synthetic
 * 3000 × 4000 page: 1030 → 215 ms RGB, 340 → 66 ms grey, two-thirds of what is
 * left being that check. Anything that does not map onto PNG exactly (no predictor,
 * TIFF's, CMYK, an inverted grey, a stream that does not inflate to exactly its
 * rows) takes the old road (`extracted`), unchanged.
 *
 * Unchanged on purpose, and still used for pages the new road could have
 * made: the two roads give the same pixels in different files, and the file's
 * hash is the page's identity. Which road a page takes is `identity.ts`, and
 * its header is the migration — in short, a PDF somebody already opened keeps
 * being read the way it was opened. **Never alter what the old road writes**:
 * `encodePng`'s bytes are the identity of every page opened before, filed in
 * this browser's stores and in cloud workspaces' rows.
 */
import { inflatesToRows } from './filters'
import { Choosing, NOTHING_KNOWN } from './identity'
import { applyFilter, decodeStream, filtersOf, isDict, isStream, nameOf, parsePdf, PdfName, PdfRef } from './objects'
import { encodePng, wrapPng } from './png'

import type { Known } from './identity'
import type { PngShape } from './png'
import type { PickedImage } from '../images'
import type { PdfDict, PdfDocument, PdfStream, PdfValue } from './objects'

/** Codecs whose bytes we cannot turn into anything a browser can draw. */
const CODECS: Record<string, string> = {
  JPXDecode: 'JPEG 2000',
  CCITTFaxDecode: 'CCITT fax',
  CCF: 'CCITT fax',
  JBIG2Decode: 'JBIG2',
}

/** One image, out of the file and ready to be a page. */
export interface PdfPage {
  /** `001.jpg` — numbered by where it came in the book, padded to sort. */
  name: string
  type: string
  data: Uint8Array
}

/** Where the extraction has got to, reported after each image is considered. */
export interface PdfArrival {
  /** What came out, or nothing where that one could not be read. */
  page: PdfPage | null
  /** Images considered so far, including the ones that yielded nothing. */
  done: number
  /** Images in the file — known from the first arrival onwards. */
  total: number
}

/**
 * The images in a PDF, one at a time, in page order.
 *
 * A generator rather than an array because the first page of a two-hundred
 * page book is worth having long before the last: the caller can put it on
 * screen and come back for the rest, and pulling one at a time is also what
 * keeps a whole chapter's pixels from being held at once. Between yields the
 * event loop is free, so the thread this runs on stays answerable — which
 * matters even in a worker, where it is the only way progress gets reported.
 *
 * What goes wrong is thrown, and the throw is worth the wait: a file with no
 * images, or none readable, is a thing to say rather than an empty return.
 *
 * `known` is what the page's thread knows of the pages this book might
 * already be — see `identity.ts`. Left out, nothing is known and every page
 * that can take the new road does.
 */
export async function * readPdf (bytes: Uint8Array, password?: string, known: Known | Promise<Known> = NOTHING_KNOWN): AsyncGenerator<PdfArrival> {
  const doc = await parsePdf(bytes, password)
  const streams = imageStreams(doc)
  const choosing = new Choosing<Page>(known)

  if (!streams.length) throw new Error('No images were found inside it.')

  const skipped = new Set<string>()
  const pad = Math.max(3, String(streams.length).length)
  let out = 0

  for (const [i, stream] of streams.entries()) {
    let image: Extracted | null = null

    try {
      // Through the document rather than off the stream: on a locked file the
      // bytes in the stream are ciphertext, and a JPEG handed over unread
      // would be handed over unreadable. Read once for both roads.
      const data = await doc.bytes(stream)
      const fits = await wrappable(doc, stream).catch(() => null)

      image = fits
        ? await choosing.choose(() => wrapped(fits, data), () => extracted(doc, stream, data))
        : await extracted(doc, stream, data)
    } catch (error) {
      // One page that will not come out is one page, said in the console and
      // survived — unless it turns out to have been every page, below.
      console.warn('[kemolate] one image in the PDF could not be extracted', error)
    }

    // A codec we cannot draw comes back named, so that a file made entirely of
    // them can say which rather than "nothing could be read".
    if (typeof image === 'string') {
      skipped.add(image)
      image = null
    }

    const name = image ? `${String(++out).padStart(pad, '0')}.${image.ext}` : ''

    yield {
      page: image ? { name, type: image.type, data: image.data } : null,
      done: i + 1,
      total: streams.length,
    }
  }

  if (!out) {
    if (skipped.size) throw new Error(`Its images use ${[...skipped].join(' and ')} compression, which can’t be opened here.`)

    throw new Error('None of the images inside it could be read.')
  }
}

/** One extracted image as a page, under the book it came out of. */
export function asPicked (page: PdfPage, path: string): PickedImage {
  return {
    file: new File([page.data as BlobPart], page.name, { type: page.type }),
    path: `${path}/${page.name}`,
  }
}

/** An image out of the file, as the bytes of a file of its own. */
type Page = { data: Uint8Array, ext: string, type: string }

type Extracted = Page | string

/**
 * The image streams of the document, ordered by the page tree.
 *
 * Walking pages rather than objects is what puts page two after page one —
 * object numbers only usually agree with reading order. A file whose page
 * tree is missing or broken falls back to every image object in the file, in
 * number order, which is the whole file's images in the writer's order.
 */
function imageStreams (doc: PdfDocument): PdfStream[] {
  const out: PdfStream[] = []
  const seen = new Set<number>()

  for (const resources of pageResources(doc)) {
    collect(doc, resources, seen, out, 0)
  }

  if (out.length) return out

  return [...doc.objects.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
    .filter((value): value is PdfStream => isStream(value) && nameOf(doc.entry(value.dict, 'Subtype')) === 'Image')
}

/** Each page's resource dictionary, inherited from its parents where absent. */
function pageResources (doc: PdfDocument): PdfDict[] {
  const out: PdfDict[] = []
  const seen = new Set<PdfValue>()

  const walk = (node: PdfValue | undefined, inherited: PdfDict | undefined, depth: number) => {
    if (!isDict(node) || depth > 64 || seen.has(node)) return

    seen.add(node)

    const resources = doc.entry(node, 'Resources')
    const own = isDict(resources) ? resources : inherited
    const kids = doc.entry(node, 'Kids')

    if (Array.isArray(kids)) {
      for (const kid of kids) walk(doc.resolve(kid), own, depth + 1)

      return
    }

    if (nameOf(doc.entry(node, 'Type')) === 'Page' && own) out.push(own)
  }

  walk(catalogPages(doc), undefined, 0)

  return out
}

/** The root of the page tree, from the trailer or by looking for it. */
function catalogPages (doc: PdfDocument): PdfValue | undefined {
  for (let i = doc.trailers.length - 1; i >= 0; i--) {
    const root = doc.entry(doc.trailers[i], 'Root')

    if (isDict(root)) {
      const pages = doc.entry(root, 'Pages')

      if (isDict(pages)) return pages
    }
  }

  // No trailer worth the name. The catalogue is findable anyway: it is the
  // one dictionary that calls itself one.
  let found: PdfValue | undefined

  for (const value of doc.objects.values()) {
    if (isDict(value) && nameOf(doc.entry(value, 'Type')) === 'Catalog') found = value
  }

  return isDict(found) ? doc.entry(found, 'Pages') : undefined
}

/** The images among a page's XObjects — and inside its forms, which nest. */
function collect (doc: PdfDocument, resources: PdfDict, seen: Set<number>, out: PdfStream[], depth: number) {
  if (depth > 8) return

  const xobjects = doc.entry(resources, 'XObject')

  if (!isDict(xobjects)) return

  for (const value of xobjects.values()) {
    // Dedupe by reference: the same scan used on two pages is one scan, and
    // a logo stamped on every page would otherwise be two hundred pages.
    const num = value instanceof PdfRef ? value.num : null

    if (num !== null && seen.has(num)) continue
    if (num !== null) seen.add(num)

    const stream = doc.resolve(value)

    if (!isStream(stream)) continue

    const kind = nameOf(doc.entry(stream.dict, 'Subtype'))

    if (kind === 'Image') out.push(stream)

    if (kind === 'Form') {
      const inner = doc.entry(stream.dict, 'Resources')

      if (isDict(inner)) collect(doc, inner, seen, out, depth + 1)
    }
  }
}

/**
 * One image stream, out of the file — the old road, and the only road for
 * everything `wrapped` turns away.
 *
 * JPEGs pass through untouched — the bytes in the stream *are* a JPEG file,
 * and handing them over unread is the only way to be sure nothing was lost.
 * Everything decodable is undone to bare scanlines and wrapped into PNG.
 * A string comes back for codecs there is no way to draw, naming the codec.
 *
 * `data` is the stream's bytes as `doc.bytes` gives them: decrypted, filters
 * still on.
 */
async function extracted (doc: PdfDocument, stream: PdfStream, data: Uint8Array): Promise<Extracted> {
  const resolve = (value: PdfValue | undefined) => doc.resolve(value)
  const filters = filtersOf(stream.dict, resolve)

  for (let i = 0; i < filters.length; i++) {
    const { name, parms } = filters[i]!
    const last = i === filters.length - 1

    if (name === 'DCTDecode' || name === 'DCT') {
      // Anything after DCT would mean the JPEG itself was re-wrapped, which
      // nothing real writes; skipping is better than mis-decoding.
      if (!last) return 'JPEG'

      return { data, ext: 'jpg', type: 'image/jpeg' }
    }

    if (CODECS[name]) return CODECS[name]!

    data = await applyFilter(name, data, parms, resolve)
  }

  return raster(doc, stream.dict, data)
}

/**
 * Whether a raster's compressed bytes are already a PNG's, by its dictionary —
 * the PNG it would be, or null and the old road.
 *
 * Already a PNG's means: one filter, Flate; a PNG predictor (10 and up) whose
 * colours, bits and columns are the image's own, so the rows inside are the
 * rows a PNG of this image holds; and a colour space PNG carries without the
 * old road changing a sample — grey not inverted by `/Decode`, RGB at 8 or 16
 * bits, a palette at 8 or fewer. The header and palette are the ones `raster`
 * would write, so the two files differ in their IDAT alone.
 *
 * Nothing is inflated here: this is what a page is asked before anything
 * waits on what is known of it, and a JPEG must get its answer at once.
 */
async function wrappable (doc: PdfDocument, stream: PdfStream): Promise<PngShape | null> {
  const filters = filtersOf(stream.dict, (value) => doc.resolve(value))

  if (filters.length !== 1) return null

  const { name, parms } = filters[0]!

  if (name !== 'FlateDecode' && name !== 'Fl') return null

  const shape = await shapeOf(doc, stream.dict)

  if (typeof shape === 'string' || shape.flip) return null

  const { width, height, depth, space } = shape
  const color = space.kind === 'rgb' ? 2 : space.kind === 'indexed' ? 3 : space.kind === 'gray' ? 0 : null

  if (color === null || (color === 2 && depth < 8) || (color === 3 && depth > 8)) return null

  const setting = (key: string, fallback: number) => {
    const value = doc.resolve(parms?.get(key))

    return typeof value === 'number' ? value : fallback
  }

  if (setting('Predictor', 1) < 10) return null
  if (setting('Colors', 1) !== (color === 2 ? 3 : 1) || setting('BitsPerComponent', 8) !== depth || setting('Columns', 1) !== width) return null

  return { width, height, depth, color, palette: space.kind === 'indexed' ? space.palette : undefined }
}

/**
 * The new road: the PDF's compressed rows put into a PNG as they are — if they
 * inflate to exactly the rows the header promises (`inflatesToRows`), since
 * the old road pads a short page and forgives what a PNG decoder does not.
 * Null otherwise, and the page takes the old road after all.
 */
async function wrapped (shape: PngShape, data: Uint8Array): Promise<Page | null> {
  const channels = shape.color === 2 ? 3 : 1

  if (!await inflatesToRows(data, Math.ceil((shape.width * channels * shape.depth) / 8), shape.height)) return null

  return { data: wrapPng(shape, data), ext: 'png', type: 'image/png' }
}

/** What a raster's dictionary says its rows are. */
interface Shape {
  width: number
  height: number
  depth: number
  space: Space
  /** `/Decode [1 0]` on a grey: the old road inverts every byte. */
  flip: boolean
}

/**
 * The size, depth and colours of a raster, read from its dictionary — or a
 * string naming why it cannot be carried, the way `raster` reports one. Throws
 * where `raster` always threw. Shared by both roads so they cannot come to
 * different conclusions about the same image.
 */
async function shapeOf (doc: PdfDocument, dict: PdfDict): Promise<Shape | string> {
  const width = doc.int(dict, 'Width', doc.int(dict, 'W'))
  const height = doc.int(dict, 'Height', doc.int(dict, 'H'))

  if (width < 1 || height < 1) throw new Error('an image with no size')

  const mask = doc.entry(dict, 'ImageMask') === true
  const depth = mask ? 1 : doc.int(dict, 'BitsPerComponent', doc.int(dict, 'BPC', 8))
  const space = mask ? { kind: 'gray' as const } : await colorSpace(doc, doc.entry(dict, 'ColorSpace') ?? doc.entry(dict, 'CS'))

  if (!space) return 'an unsupported colour space'
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`${depth} bits per component`)

  // `/Decode [1 0]` flips the scale — white-is-zero greys, mostly. Only grey
  // is flipped: an inverted palette or RGB would be a decode array no scanner
  // writes.
  const decode = doc.entry(dict, 'Decode') ?? doc.entry(dict, 'D')
  const flip = space.kind === 'gray' && Array.isArray(decode) && doc.resolve(decode[0]) === 1

  return { width, height, depth, space, flip }
}

/** Bare scanlines, judged by their dictionary and wrapped into a PNG. */
async function raster (doc: PdfDocument, dict: PdfDict, data: Uint8Array): Promise<Extracted> {
  const shape = await shapeOf(doc, dict)

  if (typeof shape === 'string') return shape

  const { width, height, depth, space, flip } = shape
  const channels = space.kind === 'rgb' ? 3 : space.kind === 'cmyk' ? 4 : 1
  const rowBytes = Math.ceil((width * channels * depth) / 8)
  const expected = rowBytes * height

  // Short data is padded rather than refused: a truncated last row is a
  // stripe of black at the bottom of a page that otherwise opens fine.
  let rows = data.length === expected ? data : data.subarray(0, expected)

  if (rows.length < expected) {
    const padded = new Uint8Array(expected)

    padded.set(rows)
    rows = padded
  }

  // With every sample at full width in its bits, flipping the scale is
  // inverting the bits.
  if (flip) rows = rows.map((byte) => byte ^ 0xff)

  if (space.kind === 'cmyk') {
    if (depth !== 8) return 'a deep CMYK encoding'

    return {
      data: await encodePng({ width, height, depth: 8, color: 2, data: cmykToRgb(rows, width, height) }),
      ext: 'png',
      type: 'image/png',
    }
  }

  if (space.kind === 'indexed') {
    if (depth === 16) return 'a deep palette encoding'

    return {
      data: await encodePng({ width, height, depth, color: 3, palette: space.palette, data: rows }),
      ext: 'png',
      type: 'image/png',
    }
  }

  if (space.kind === 'rgb' && depth < 8) return 'a packed RGB encoding'

  return {
    data: await encodePng({ width, height, depth, color: space.kind === 'rgb' ? 2 : 0, data: rows }),
    ext: 'png',
    type: 'image/png',
  }
}

type Space =
  | { kind: 'gray' | 'rgb' | 'cmyk' }
  | { kind: 'indexed', palette: Uint8Array }

/**
 * What the samples mean, boiled down to the four shapes we can carry.
 *
 * The exotics are mapped by their component count — an ICC profile with three
 * channels is RGB for our purposes, a separation is a grey — which wrongs
 * nobody's scans and spares this file a colour management system.
 */
async function colorSpace (doc: PdfDocument, value: PdfValue | undefined): Promise<Space | null> {
  const named = (name: string | null): Space | null => {
    if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') return { kind: 'gray' }
    if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') return { kind: 'rgb' }
    if (name === 'DeviceCMYK' || name === 'CMYK') return { kind: 'cmyk' }

    return null
  }

  if (value instanceof PdfName) return named(value.name)

  if (!Array.isArray(value)) return null

  const head = nameOf(doc.resolve(value[0]) as PdfValue)

  if (head === 'ICCBased') {
    const profile = doc.resolve(value[1])
    const n = isStream(profile) ? doc.int(profile.dict, 'N', 3) : 3

    return n === 4 ? { kind: 'cmyk' } : n === 1 ? { kind: 'gray' } : { kind: 'rgb' }
  }

  if (head === 'Separation') return { kind: 'gray' }

  if (head === 'DeviceN') {
    const names = doc.resolve(value[1])
    const n = Array.isArray(names) ? names.length : 0

    return n === 1 ? { kind: 'gray' } : n === 3 ? { kind: 'rgb' } : n === 4 ? { kind: 'cmyk' } : null
  }

  if (head === 'Indexed' || head === 'I') {
    const base = await colorSpace(doc, doc.resolve(value[1]) as PdfValue)
    const high = doc.resolve(value[2])
    const lookup = doc.resolve(value[3])

    if (!base || base.kind === 'indexed' || typeof high !== 'number') return null

    const table = isStream(lookup)
      ? await decodeStream(doc, lookup)
      : lookup instanceof Uint8Array ? lookup : null

    if (!table) return null

    return { kind: 'indexed', palette: paletteFrom(base.kind, table, high + 1) }
  }

  return named(head)
}

/** The lookup table as PNG's RGB triples, whatever space it was written in. */
function paletteFrom (kind: 'gray' | 'rgb' | 'cmyk', table: Uint8Array, entries: number) {
  const per = kind === 'rgb' ? 3 : kind === 'cmyk' ? 4 : 1
  const out = new Uint8Array(Math.min(entries, 256) * 3)

  for (let i = 0; i * 3 < out.length; i++) {
    const at = i * per

    if (kind === 'gray') {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = table[at] ?? 0
    } else if (kind === 'rgb') {
      out[i * 3] = table[at] ?? 0
      out[i * 3 + 1] = table[at + 1] ?? 0
      out[i * 3 + 2] = table[at + 2] ?? 0
    } else {
      const [r, g, b] = cmykPixel(table[at] ?? 0, table[at + 1] ?? 0, table[at + 2] ?? 0, table[at + 3] ?? 0)

      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
  }

  return out
}

function cmykToRgb (data: Uint8Array, width: number, height: number) {
  const out = new Uint8Array(width * height * 3)

  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = cmykPixel(data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0, data[i * 4 + 3] ?? 0)

    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }

  return out
}

/** The naive conversion — no profiles, which is all a raw CMYK deserves. */
function cmykPixel (c: number, m: number, y: number, k: number): [number, number, number] {
  return [
    Math.round((255 - c) * (255 - k) / 255),
    Math.round((255 - m) * (255 - k) / 255),
    Math.round((255 - y) * (255 - k) / 255),
  ]
}
