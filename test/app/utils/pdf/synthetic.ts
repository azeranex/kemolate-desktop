import { deflateSync, inflateSync } from 'node:zlib'

/**
 * PDFs made to order, and a PNG decoder that owes nothing to the app.
 *
 * The extractor's tests need files whose every byte they know: an image stream
 * Flate-compressed over PNG-predicted rows (predictor 15, the one scanners and
 * `img2pdf` write), one compressed over bare rows (no predictor, which has to
 * take the old road), and the rest. No chapter on this machine is fair game
 * and none is needed — the bytes are drawn here.
 *
 * The decoder is the other half. "The same pixels" is only a claim worth making
 * if something other than the code under test says what the pixels are, so
 * this undoes a PNG from the specification with `node:zlib` doing the inflating
 * — the same check any strict decoder makes.
 */

/** A page of rows, the way a PDF stores them before any filter. */
export interface Raster {
  width: number
  height: number
  /** 1 grey or palette, 3 RGB. */
  channels: 1 | 3
  /** Bits per sample. */
  depth: number
  /** Scanlines, each padded to a whole byte. */
  rows: Uint8Array
}

export const rowBytesOf = ({ width, channels, depth }: Pick<Raster, 'width' | 'channels' | 'depth'>) => Math.ceil((width * channels * depth) / 8)

/**
 * Something page-like to compress: paper, ink, and a little grain.
 *
 * Deterministic from `seed`, so a test can draw the same page twice and a
 * failure can be drawn again. Not random noise throughout — that would be a
 * page no deflate can shrink, and nothing like a scan.
 */
export function drawn (width: number, height: number, channels: 1 | 3, seed = 1, depth = 8): Raster {
  const raster = { width, height, channels, depth, rows: new Uint8Array(0) }
  const rowBytes = rowBytesOf(raster)
  const rows = new Uint8Array(rowBytes * height)
  let state = seed >>> 0 || 1

  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5

    return state >>> 0
  }

  for (let y = 0; y < height; y++) {
    for (let i = 0; i < rowBytes; i++) {
      const x = Math.floor(i / channels)
      const ink = (x + y) % 97 < 3 || (x * 7 + y * 3) % 211 < 2
      const paper = 240 + (next() & 0x0f)

      rows[y * rowBytes + i] = depth === 8 ? (ink ? (next() & 0x3f) : paper - ((y >> 4) & 0x07)) : next() & 0xff
    }
  }

  raster.rows = rows

  return raster
}

function paeth (left: number, up: number, corner: number) {
  const guess = left + up - corner
  const dl = Math.abs(guess - left)
  const du = Math.abs(guess - up)
  const dc = Math.abs(guess - corner)

  if (dl <= du && dl <= dc) return left

  return du <= dc ? up : corner
}

/**
 * The rows with PNG's per-row predictors applied, as a PDF with `/Predictor
 * 15` stores them: a filter byte, then the differences. Every one of the five
 * filters is used, in turn, so a reader that undid only some would show it.
 */
export function predicted ({ rows, height, ...shape }: Raster): Uint8Array {
  const rowBytes = rowBytesOf(shape)
  const step = Math.max(1, (shape.channels * shape.depth) >> 3)
  const out = new Uint8Array((rowBytes + 1) * height)

  for (let y = 0; y < height; y++) {
    const kind = y % 5
    const at = y * rowBytes
    const to = y * (rowBytes + 1)

    out[to] = kind

    for (let i = 0; i < rowBytes; i++) {
      const raw = rows[at + i]!
      const left = i >= step ? rows[at + i - step]! : 0
      const up = y ? rows[at - rowBytes + i]! : 0
      const corner = y && i >= step ? rows[at - rowBytes + i - step]! : 0
      const guess = kind === 1 ? left : kind === 2 ? up : kind === 3 ? (left + up) >> 1 : kind === 4 ? paeth(left, up, corner) : 0

      out[to + 1 + i] = (raw - guess) & 0xff
    }
  }

  return out
}

export const flate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes))

/** One image to put in a PDF: the dictionary's entries as PDF source, and the stream. */
export interface PdfImage {
  dict: string
  data: Uint8Array
}

/** The dictionary for a Flate image over predicted rows — the pass-through case. */
export const predictedDict = ({ width, height, channels, depth }: Raster, space = channels === 3 ? '/DeviceRGB' : '/DeviceGray') =>
  `/Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent ${depth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${channels} /BitsPerComponent ${depth} /Columns ${width} >>`

/** A Flate image over predicted rows, ready for `pdfOf`. */
export const predictedImage = (raster: Raster, space?: string): PdfImage => ({
  dict: predictedDict(raster, space),
  data: flate(predicted(raster)),
})

const ascii = new TextEncoder()

/**
 * A PDF holding these images, one per page, with a correct cross-reference
 * table — built the way `utils/pdf/write.ts` builds one, but with any image
 * dictionary a test wants to put in it.
 */
export function pdfOf (images: PdfImage[], extra: string[] = []): Uint8Array {
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0

  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? ascii.encode(part) : part

    parts.push(bytes)
    length += bytes.length
  }

  const open = (id: number) => {
    offsets[id] = length
    put(`${id} 0 obj\n`)
  }

  put('%PDF-1.4\n')

  // 1 the catalog, 2 the page tree, then a page and its image for each; any
  // `extra` objects (a palette, say) are numbered after those.
  const pageId = (index: number) => 3 + index * 2
  const extraId = 3 + images.length * 2

  open(1)
  put('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  open(2)
  put(`<< /Type /Pages /Kids [${images.map((_, index) => `${pageId(index)} 0 R`).join(' ')}] /Count ${images.length} >>\nendobj\n`)

  for (const [index, image] of images.entries()) {
    const id = pageId(index)

    open(id)
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> >>\nendobj\n`)

    open(id + 1)
    put(`<< /Type /XObject /Subtype /Image ${image.dict} /Length ${image.data.length} >>\nstream\n`)
    put(image.data)
    put('\nendstream\nendobj\n')
  }

  for (const [index, body] of extra.entries()) {
    open(extraId + index)
    put(`${body}\nendobj\n`)
  }

  const count = extraId + extra.length
  const xref = length

  put(`xref\n0 ${count}\n0000000000 65535 f \n`)

  for (let id = 1; id < count; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)

  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

/** A PNG's chunks, in order. */
export function pngChunks (png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: { type: string, data: Uint8Array }[] = []

  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at)

    out.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) })
    at += 12 + length
  }

  return out
}

/** The image data a PNG carries: every IDAT's bytes, joined. */
export function idatOf (png: Uint8Array): Uint8Array {
  const parts = pngChunks(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)

  return new Uint8Array(Buffer.concat(parts))
}

/**
 * A PNG decoded to RGBA, by the specification: inflate, undo each row's filter,
 * unpack the samples, look the palette up. Sixteen-bit samples keep their high
 * byte, as a browser drawing to an 8-bit canvas does.
 *
 * Also hands back the reconstructed scanlines themselves, which is the stricter
 * comparison — RGBA would forgive a difference in a 16-bit sample's low byte.
 */
export function decodePng (png: Uint8Array) {
  const chunks = pngChunks(png)
  const header = chunks.find((chunk) => chunk.type === 'IHDR')!.data
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const depth = header[8]!
  const color = header[9]!
  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data
  const channels = color === 2 ? 3 : 1
  const rowBytes = rowBytesOf({ width, channels, depth })
  const step = Math.max(1, (channels * depth) >> 3)
  const filtered = new Uint8Array(inflateSync(idatOf(png)))

  if (filtered.length !== (rowBytes + 1) * height) throw new Error(`image data is ${filtered.length} bytes, not ${(rowBytes + 1) * height}`)

  const rows = new Uint8Array(rowBytes * height)

  for (let y = 0; y < height; y++) {
    const kind = filtered[y * (rowBytes + 1)]!

    if (kind > 4) throw new Error(`row ${y} has filter ${kind}`)

    for (let i = 0; i < rowBytes; i++) {
      const at = y * rowBytes + i
      const left = i >= step ? rows[at - step]! : 0
      const up = y ? rows[at - rowBytes]! : 0
      const corner = y && i >= step ? rows[at - rowBytes - step]! : 0
      const guess = kind === 1 ? left : kind === 2 ? up : kind === 3 ? (left + up) >> 1 : kind === 4 ? paeth(left, up, corner) : 0

      rows[at] = (filtered[y * (rowBytes + 1) + 1 + i]! + guess) & 0xff
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  const bytesPer = depth === 16 ? 2 : 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      const sample = (c: number) => {
        if (depth >= 8) return rows[y * rowBytes + (x * channels + c) * bytesPer]!

        const bit = (x * channels + c) * depth
        const byte = rows[y * rowBytes + (bit >> 3)]!

        return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
      }

      if (color === 3) {
        const index = sample(0)

        rgba.set([palette![index * 3]!, palette![index * 3 + 1]!, palette![index * 3 + 2]!, 255], out)
      } else if (color === 2) {
        rgba.set([sample(0), sample(1), sample(2), 255], out)
      } else {
        const grey = depth >= 8 ? sample(0) : Math.round((sample(0) * 255) / ((1 << depth) - 1))

        rgba.set([grey, grey, grey, 255], out)
      }
    }
  }

  return { width, height, depth, color, rows, rgba }
}
