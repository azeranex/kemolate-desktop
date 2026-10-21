import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodePng, drawn, flate, idatOf, pdfOf, predicted, predictedDict, predictedImage, rowBytesOf } from './synthetic'

import type { PdfImage, Raster } from './synthetic'

import { readPdf } from '~/utils/pdf/extract'
import { encodePng } from '~/utils/pdf/png'

/**
 * A compressed raster in a PDF comes out as a PNG around the PDF's own bytes,
 * where those bytes are already a PNG's — and by the old road where not.
 *
 * The old road inflated every Flate image, undid its predictor a byte at a
 * time and deflated it again: ~0.7 s a page in the browser, every visit. A
 * stream of PNG-predicted rows (`/Predictor 15`) is a PNG's image data as it
 * stands, so the new road puts it in an IDAT untouched. Three things are held
 * here:
 *
 * - **It is untouched.** The IDAT is the stream, byte for byte — which the old
 *   road, deflating afresh, never produced.
 * - **It is the same picture.** Decoded by `decodePng` (the specification over
 *   `node:zlib`, not the app's code), the new file gives exactly the rows and
 *   the RGBA the old road's file gives, for grey, RGB, 16-bit, 1-bit and
 *   palette images. The old road's file is `encodePng` over the rows, which is
 *   what `raster` has always handed it.
 * - **What does not map takes the old road, unchanged.** No predictor, TIFF's
 *   predictor, an inverted grey, a stream a row short, and raw deflate with no
 *   zlib header each come out byte-identical to what the old road wrote.
 *
 * Seam: `readPdf` over PDFs drawn by `synthetic.ts`, knowing nothing — a new
 * book, so every page that can take the new road does (`identity.ts` decides
 * otherwise for books already opened; see `migration.test.ts`).
 */

/** Every page of a PDF, as the reader hands them over. */
async function pages (pdf: Uint8Array) {
  const out: Uint8Array[] = []

  for await (const { page } of readPdf(pdf)) out.push(page!.data)

  return out
}

/** What the old road writes for these rows: `encodePng`, as `raster` calls it. */
const oldRoad = (raster: Raster, color: 0 | 2 | 3 = raster.channels === 3 ? 2 : 0, palette?: Uint8Array) =>
  encodePng({ width: raster.width, height: raster.height, depth: raster.depth, color, palette, data: raster.rows })

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** Sixteen palette entries, as the PDF's hex string and as PNG's triples. */
const PALETTE = Uint8Array.from({ length: 48 }, (_, i) => (i * 37) & 0xff)

const cases: { name: string, raster: Raster, image: PdfImage, color?: 0 | 2 | 3, palette?: Uint8Array }[] = (() => {
  const rgb = drawn(61, 47, 3, 11)
  const grey = drawn(59, 43, 1, 12)
  const deep = drawn(23, 19, 1, 13, 16)
  const deepRgb = drawn(17, 13, 3, 14, 16)
  const bits = drawn(45, 21, 1, 15, 1)
  const indexed = drawn(33, 27, 1, 16, 4)

  return [
    { name: 'RGB, 8 bits', raster: rgb, image: predictedImage(rgb) },
    { name: 'grey, 8 bits', raster: grey, image: predictedImage(grey) },
    { name: 'grey, 16 bits', raster: deep, image: predictedImage(deep) },
    { name: 'RGB, 16 bits', raster: deepRgb, image: predictedImage(deepRgb) },
    { name: 'grey, 1 bit', raster: bits, image: predictedImage(bits) },
    {
      name: 'a palette, 4 bits',
      raster: indexed,
      image: predictedImage(indexed, `[/Indexed /DeviceRGB 15 <${hex(PALETTE)}>]`),
      color: 3,
      palette: PALETTE,
    },
  ]
})()

describe('a Flate image over PNG-predicted rows', () => {
  it('comes out as a PNG whose image data is the stream in the PDF, untouched', async () => {
    const [rgb, grey] = cases

    const out = await pages(pdfOf([rgb!.image, grey!.image]))

    expect(out).toHaveLength(2)
    expect(idatOf(out[0]!)).toEqual(rgb!.image.data)
    expect(idatOf(out[1]!)).toEqual(grey!.image.data)
  })

  it.each(cases)('decodes to the rows and pixels the old road gave — $name', async ({ raster, image, color, palette }) => {
    const [fresh] = await pages(pdfOf([image]))
    const before = await oldRoad(raster, color, palette)

    // Not the old file…
    expect(idatOf(fresh!)).toEqual(image.data)
    expect(hex(fresh!)).not.toBe(hex(before))

    // …and the same picture, down to the last sample.
    const now = decodePng(fresh!)
    const then = decodePng(before)

    expect(now.rows).toEqual(raster.rows)
    expect(now.rows).toEqual(then.rows)
    expect(now.rgba).toEqual(then.rgba)
    expect([now.width, now.height, now.depth, now.color]).toEqual([then.width, then.height, then.depth, then.color])
  })
})

describe('what does not map onto PNG', () => {
  const raster = drawn(40, 30, 3, 21)
  const grey = drawn(40, 30, 1, 22)
  const size = '/Width 40 /Height 30 /BitsPerComponent 8'

  /** TIFF's predictor 2: each sample less the one to its left. */
  const tiff = (({ rows, height }: Raster) => {
    const rowBytes = rowBytesOf(raster)
    const out = rows.slice()

    for (let y = 0; y < height; y++) {
      for (let i = rowBytes - 1; i >= 3; i--) out[y * rowBytes + i] = (rows[y * rowBytes + i]! - rows[y * rowBytes + i - 3]!) & 0xff
    }

    return out
  })(raster)

  const short = { ...raster, height: 29, rows: raster.rows.subarray(0, rowBytesOf(raster) * 29) }
  const padded = new Uint8Array(raster.rows.length)

  padded.set(short.rows)

  it.each([
    {
      name: 'no predictor',
      image: { dict: `${size} /ColorSpace /DeviceRGB /Filter /FlateDecode`, data: flate(raster.rows) },
      before: () => oldRoad(raster),
    },
    {
      name: 'TIFF’s predictor',
      image: { dict: `${size} /ColorSpace /DeviceRGB /Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 3 /Columns 40 >>`, data: flate(tiff) },
      before: () => oldRoad(raster),
    },
    {
      name: 'an inverted grey',
      image: { dict: `${predictedDict(grey)} /Decode [1 0]`, data: flate(predicted(grey)) },
      before: () => oldRoad({ ...grey, rows: grey.rows.map((byte) => byte ^ 0xff) }),
    },
    {
      name: 'a stream one row short, which the old road pads',
      image: { dict: predictedDict(raster), data: flate(predicted(short)) },
      before: () => oldRoad({ ...raster, rows: padded }),
    },
    {
      name: 'raw deflate with no zlib header',
      image: { dict: predictedDict(raster), data: new Uint8Array(deflateRawSync(predicted(raster))) },
      before: () => oldRoad(raster),
    },
  ])('takes the old road, and writes what it always wrote — $name', async ({ image, before }) => {
    const [out] = await pages(pdfOf([image]))

    expect(hex(out!)).toBe(hex(await before()))
  })
})
